import {
  AgentstackCallEvent,
  AgentstackDiffReport,
  AgentstackDoctorReport,
  AgentstackRestoreInventory,
  AgentstackSetupPlan,
  AgentstackTrustPreview,
  AgentstackWorkflowRun,
  AgentstackWorkflowRunSummary,
  AgentstackWorkflowSummary,
  type AgentstackActionKind,
  type AgentstackActionResult,
  type AgentstackActivity,
  type AgentstackDiffResult,
  type AgentstackIncompatible,
  type AgentstackRestoreInventoryResult,
  type AgentstackSetupPlanResult,
  type AgentstackStatus,
  type AgentstackTrustPreviewResult,
  type AgentstackWorkflowData,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const COMMAND_TIMEOUT = "15 seconds";
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/** Re-probe the CLI version at most this often (it changes on upgrades). */
const VERSION_PROBE_TTL = Duration.minutes(5);

/**
 * Server-internal request: the workspace root is always resolved from the
 * orchestration projections by the caller (see the `agentstack.status` RPC
 * handler in `ws.ts`), never taken from a client.
 */
export interface AgentstackStatusRequest {
  readonly workspaceRoot: string;
}

/** Server-internal request for the recent-calls feed; same path rule. */
export interface AgentstackActivityRequest {
  readonly workspaceRoot: string;
  readonly limit: number;
}

/** Server-internal request naming a resolved workspace root; same path rule. */
export interface AgentstackWorkspaceRequest {
  readonly workspaceRoot: string;
}

/** One recorded workflow run's evidence tree, by envelope run id. */
export interface AgentstackWorkflowRunRequest {
  readonly workspaceRoot: string;
  readonly runId: string;
}

/**
 * The only client-influenced value that ever reaches the CLI's argv. The CLI
 * itself rejects unsafe path segments, but validate the shape here too —
 * defense in depth, and a cheaper failure.
 */
const WORKFLOW_RUN_ID = /^w-[a-z0-9]{6,32}$/;

/** A read-only drift preview against a resolved workspace root, at one scope. */
export interface AgentstackDiffRequest {
  readonly workspaceRoot: string;
  readonly scope: "global" | "project";
}

/** A governed action against a resolved workspace root. */
export interface AgentstackActionRequest {
  readonly workspaceRoot: string;
  readonly action: AgentstackActionKind;
  /**
   * `trust-grant` only: the `surface_digest` the client's review dialog got
   * from `trust --preview`. Mapped to `--consented-digest`; a grant without
   * it is refused before anything spawns.
   */
  readonly consentedDigest?: string;
  /**
   * `setup-apply` only: the `plan_digest` from the reviewed `init --plan`.
   * Mapped to `--consented-plan`; an apply without it (or with a malformed
   * one) is refused before anything spawns.
   */
  readonly planDigest?: string;
  /**
   * `restore-write` only: the full hex ledger `id` to undo. A write with an
   * absent or malformed id is refused before anything spawns.
   */
  readonly restoreId?: string;
}

/**
 * The only digest shape the CLI ever emits (`sha256:<64 hex>`). Anything else
 * is refused before it reaches an argv — spawning is args-array (no shell),
 * so this is shape hygiene, not injection defense. Shared by trust-grant's
 * `--consented-digest` and setup-apply's `--consented-plan`.
 */
export const CONSENT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The restore ledger id shape (full or short hex). Same fail-closed hygiene. */
export const RESTORE_ID_RE = /^[0-9a-f]{8,64}$/;

/**
 * The envelope `schema_version` this build understands. A read whose payload
 * declares a higher version is surfaced as `incompatible` rather than silently
 * degraded — the client must be told to update, not shown a half-decoded view.
 */
export const SUPPORTED_AGENTSTACK_SCHEMA = 1;

/** The versioned-envelope fields any decoded read payload may carry. */
interface AgentstackEnvelope {
  readonly schema_version?: number;
  readonly features?: ReadonlyArray<string>;
}

/**
 * Turn a decoded payload's envelope into the negotiation fields carried on a
 * read result. An ABSENT envelope (older CLI) reads as `features: []` and no
 * incompatibility — the existing silent-optional behaviour. A `schema_version`
 * above [`SUPPORTED_AGENTSTACK_SCHEMA`] yields a non-null `incompatible` so the
 * client can render "update t3code"; `features` is still surfaced when present.
 * `null`/undefined payload (a read that failed to decode) is treated as absent.
 */
export function negotiate(payload: AgentstackEnvelope | null | undefined): {
  features: ReadonlyArray<string>;
  incompatible: AgentstackIncompatible | null;
} {
  const version = payload?.schema_version;
  const features = payload?.features ?? [];
  if (typeof version === "number" && version > SUPPORTED_AGENTSTACK_SCHEMA) {
    return {
      features,
      incompatible: { cliSchema: version, supported: SUPPORTED_AGENTSTACK_SCHEMA },
    };
  }
  return { features, incompatible: null };
}

/** Bounds for the `--tail` the CLI is asked for, whatever the client sent. */
export const ACTIVITY_LIMIT_MAX = 50;
export const ACTIVITY_LIMIT_DEFAULT = 8;

/** Governed actions can touch many CLI configs; give them room over the read TTL. */
const ACTION_TIMEOUT = "90 seconds";

const decodeDoctorReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackDoctorReport),
);

export function parseDoctorReport(stdout: string) {
  return Option.getOrNull(decodeDoctorReport(stdout));
}

// Only the `events` array matters here; the rest of the report shape may
// grow without breaking this decoder. Absent/invalid input degrades to [].
const decodeCallEvents = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ events: Schema.Array(AgentstackCallEvent) })),
);

export function parseCallEvents(stdout: string): ReadonlyArray<AgentstackCallEvent> {
  return Option.match(decodeCallEvents(stdout), {
    onNone: () => [],
    onSome: (r) => r.events,
  });
}

const decodeWorkflowList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ workflows: Schema.Array(AgentstackWorkflowSummary) })),
);

export function parseWorkflowList(stdout: string): ReadonlyArray<AgentstackWorkflowSummary> {
  return Option.match(decodeWorkflowList(stdout), {
    onNone: () => [],
    onSome: (r) => r.workflows,
  });
}

const decodeWorkflowRun = Schema.decodeUnknownOption(Schema.fromJsonString(AgentstackWorkflowRun));

export function parseWorkflowRun(stdout: string): AgentstackWorkflowRun | null {
  return Option.getOrNull(decodeWorkflowRun(stdout));
}

// `agentstack workflow runs --json` — the durable run history (newest
// first), each row read from the run's own evidence log with liveness
// already joined by the CLI. An older binary without the subcommand (or a
// malformed payload) degrades to [].
const decodeWorkflowRuns = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ runs: Schema.Array(AgentstackWorkflowRunSummary) })),
);

export function parseWorkflowRuns(stdout: string): ReadonlyArray<AgentstackWorkflowRunSummary> {
  return Option.match(decodeWorkflowRuns(stdout), {
    onNone: () => [],
    onSome: (r) => r.runs,
  });
}

const decodeTrustPreview = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackTrustPreview),
);

export function parseTrustPreview(stdout: string) {
  return Option.getOrNull(decodeTrustPreview(stdout));
}

const decodeDiffReport = Schema.decodeUnknownOption(Schema.fromJsonString(AgentstackDiffReport));

export function parseDiffReport(stdout: string) {
  return Option.getOrNull(decodeDiffReport(stdout));
}

const decodeSetupPlan = Schema.decodeUnknownOption(Schema.fromJsonString(AgentstackSetupPlan));

export function parseSetupPlan(stdout: string) {
  return Option.getOrNull(decodeSetupPlan(stdout));
}

const decodeRestoreInventory = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackRestoreInventory),
);

export function parseRestoreInventory(stdout: string) {
  return Option.getOrNull(decodeRestoreInventory(stdout));
}

/**
 * The fixed argv for each vetted action — the client never supplies one. The
 * bound values (`consentedDigest`, `planDigest`, `restoreId`) are consulted
 * only for the action that owns them, and only after the caller validated their
 * shape (see [`action`]).
 */
export function actionArgv(
  action: AgentstackActionKind,
  workspaceRoot: string,
  bound?: {
    readonly consentedDigest?: string | undefined;
    readonly planDigest?: string | undefined;
    readonly restoreId?: string | undefined;
  },
): ReadonlyArray<string> {
  switch (action) {
    case "apply-project":
    case "apply-global": {
      // Re-render configs from the manifest at the named scope, capped by the
      // machine ceiling; reversible via `agentstack restore`. NEVER
      // --prune-foreign — a default apply keeps servers another setup applied
      // and never touches hand-added servers no manifest tracks.
      const scope = action === "apply-global" ? "global" : "project";
      return ["--manifest-dir", workspaceRoot, "apply", "--scope", scope, "--write"];
    }
    case "adopt-project":
    case "adopt-global": {
      // Keep the on-disk hand-edit: pull it into the manifest. Adopt only ever
      // writes `agentstack.toml`, never a CLI's native config, so it can add a
      // server to the manifest but can never remove one from disk.
      const scope = action === "adopt-global" ? "global" : "project";
      return ["--manifest-dir", workspaceRoot, "adopt", "--scope", scope, "--write"];
    }
    case "guard-install":
      // Machine-global; only adds pre-tool-use protection (cannot loosen).
      return ["guard", "install"];
    case "trust-grant":
      // --yes + --consented-digest: the review dialog showed the surface AND
      // received its digest from `trust --preview`; presenting it back makes
      // "a human reviewed this exact surface" CLI-enforced — the CLI refuses
      // a stale or missing digest, and still self-refuses an unpinned
      // surface. The caller refuses before spawn when the digest is absent,
      // so the fallback "" here can never reach a process.
      return [
        "--manifest-dir",
        workspaceRoot,
        "trust",
        workspaceRoot,
        "--yes",
        "--consented-digest",
        bound?.consentedDigest ?? "",
      ];
    case "trust-revoke":
      return ["--manifest-dir", workspaceRoot, "trust", workspaceRoot, "--revoke"];
    case "setup-apply":
      // Apply the reviewed `init --plan`. --consented-plan presents back the
      // plan_digest the user saw; the CLI writes nothing if detection changed.
      // NO --secrets flag — both the plan read and this apply default to
      // keychain, so the digests line up. The caller refuses before spawn when
      // the digest is absent/malformed, so the "" fallback never reaches argv.
      return [
        "--manifest-dir",
        workspaceRoot,
        "init",
        "--yes",
        "--consented-plan",
        bound?.planDigest ?? "",
      ];
    case "restore-write":
      // Undo one ledger entry by its full hex id (validated before spawn).
      // Never `--last` — the ledger is machine-global and the panel already
      // picked the newest project-touching entry.
      return [
        "--manifest-dir",
        workspaceRoot,
        "restore",
        bound?.restoreId ?? "",
        "--write",
        "--json",
      ];
  }
}

function isBinaryNotFound(error: ProcessRunner.ProcessRunError): boolean {
  return (
    error._tag === "ProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  );
}

export class AgentstackCli extends Context.Service<
  AgentstackCli,
  {
    readonly status: (input: AgentstackStatusRequest) => Effect.Effect<AgentstackStatus>;
    readonly activity: (input: AgentstackActivityRequest) => Effect.Effect<AgentstackActivity>;
    readonly workflow: (input: AgentstackWorkspaceRequest) => Effect.Effect<AgentstackWorkflowData>;
    readonly workflowRun: (
      input: AgentstackWorkflowRunRequest,
    ) => Effect.Effect<AgentstackWorkflowRun | null>;
    readonly trustPreview: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackTrustPreviewResult>;
    readonly diff: (input: AgentstackDiffRequest) => Effect.Effect<AgentstackDiffResult>;
    readonly setupPlan: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackSetupPlanResult>;
    readonly restoreInventory: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackRestoreInventoryResult>;
    readonly action: (input: AgentstackActionRequest) => Effect.Effect<AgentstackActionResult>;
  }
>()("t3/agentstack/AgentstackCli") {}

export const make = Effect.fn("AgentstackCli.make")(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const configuredBinary = process.env.T3CODE_AGENTSTACK_BIN?.trim();
  const binary = configuredBinary ? configuredBinary : "agentstack";
  const run = (args: ReadonlyArray<string>) =>
    processRunner.run({
      command: binary,
      args,
      timeout: COMMAND_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: MAX_STDOUT_BYTES,
      outputMode: "truncate",
    });
  const versionCache = yield* Cache.make({
    capacity: 1,
    timeToLive: VERSION_PROBE_TTL,
    lookup: () =>
      run(["--version"]).pipe(
        Effect.map((result) => {
          if (result.timedOut || result.stdoutTruncated) return null;
          const version = result.stdout.trim();
          return version.length > 0 ? version : null;
        }),
        Effect.orElseSucceed(() => null),
      ),
  });

  const status: AgentstackCli["Service"]["status"] = Effect.fn("AgentstackCli.status")(
    function* (input) {
      const doctorResult = yield* run([
        "--manifest-dir",
        input.workspaceRoot,
        "doctor",
        "--json",
      ]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (result) => ({ _tag: "Success", result }) as const,
        }),
      );

      if (doctorResult._tag === "NotFound") {
        return {
          installed: false,
          version: null,
          doctor: null,
          features: [],
          incompatible: null,
          checkedAt: yield* Clock.currentTimeMillis,
        };
      }

      const doctor =
        doctorResult._tag === "Success" ? parseDoctorReport(doctorResult.result.stdout) : null;
      return {
        installed: true,
        version: yield* Cache.get(versionCache, "version"),
        doctor,
        // The doctor payload carries the versioned envelope; surface its
        // features (for action gating) and any schema incompatibility.
        ...negotiate(doctor),
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  const activity: AgentstackCli["Service"]["activity"] = Effect.fn("AgentstackCli.activity")(
    function* (input) {
      const limit = Math.min(Math.max(1, Math.trunc(input.limit)), ACTIVITY_LIMIT_MAX);
      const result = yield* run([
        "--manifest-dir",
        input.workspaceRoot,
        "report",
        "calls",
        "--json",
        "--tail",
        String(limit),
        "--project",
        input.workspaceRoot,
      ]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (result) => ({ _tag: "Success", result }) as const,
        }),
      );
      return {
        installed: result._tag !== "NotFound",
        events: result._tag === "Success" ? parseCallEvents(result.result.stdout) : [],
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  const workflow: AgentstackCli["Service"]["workflow"] = Effect.fn("AgentstackCli.workflow")(
    function* (input) {
      const root = input.workspaceRoot;
      const listResult = yield* run(["--manifest-dir", root, "workflow", "list", "--json"]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (result) => ({ _tag: "Success", result }) as const,
        }),
      );
      if (listResult._tag === "NotFound") {
        return {
          installed: false,
          workflows: [],
          activeRun: null,
          runs: [],
          checkedAt: yield* Clock.currentTimeMillis,
        };
      }
      const workflows =
        listResult._tag === "Success" ? parseWorkflowList(listResult.result.stdout) : [];

      // The durable run history — identity, outcome, and liveness already
      // joined by the CLI from each run's own evidence log. A failure (e.g.
      // an older binary without the subcommand) degrades to [].
      const runsResult = yield* run(["--manifest-dir", root, "workflow", "runs", "--json"]).pipe(
        Effect.orElseSucceed(() => null),
      );
      const runs = runsResult && !runsResult.timedOut ? parseWorkflowRuns(runsResult.stdout) : [];

      // A running row (there is at most one per envelope process) gets its
      // full evidence tree for the live step view. Degrades to "no run".
      const runId = runs.find((r) => r.outcome === "running")?.run ?? null;
      let activeRun: AgentstackWorkflowRun | null = null;
      if (runId) {
        const reportResult = yield* run([
          "--manifest-dir",
          root,
          "workflow",
          "report",
          runId,
          "--json",
        ]).pipe(Effect.orElseSucceed(() => null));
        activeRun =
          reportResult && !reportResult.timedOut ? parseWorkflowRun(reportResult.stdout) : null;
      }

      return {
        installed: true,
        workflows,
        activeRun,
        runs,
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  const workflowRun: AgentstackCli["Service"]["workflowRun"] = Effect.fn(
    "AgentstackCli.workflowRun",
  )(function* (input) {
    // The run id came from a client. Refuse anything that isn't a plausible
    // envelope id before it reaches argv — the CLI validates too, but the
    // cheap refusal belongs at the boundary.
    if (!WORKFLOW_RUN_ID.test(input.runId)) return null;
    const result = yield* run([
      "--manifest-dir",
      input.workspaceRoot,
      "workflow",
      "report",
      input.runId,
      "--json",
    ]).pipe(Effect.orElseSucceed(() => null));
    return result && !result.timedOut ? parseWorkflowRun(result.stdout) : null;
  });

  const trustPreview: AgentstackCli["Service"]["trustPreview"] = Effect.fn(
    "AgentstackCli.trustPreview",
  )(function* (input) {
    const root = input.workspaceRoot;
    const result = yield* run(["--manifest-dir", root, "trust", root, "--preview"]).pipe(
      Effect.match({
        onFailure: (error) =>
          isBinaryNotFound(error) ? ({ _tag: "NotFound" } as const) : ({ _tag: "Failed" } as const),
        onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
      }),
    );
    const preview = result._tag === "Success" ? parseTrustPreview(result.result.stdout) : null;
    return {
      installed: result._tag !== "NotFound",
      preview,
      ...negotiate(preview),
      checkedAt: yield* Clock.currentTimeMillis,
    };
  });

  const diff: AgentstackCli["Service"]["diff"] = Effect.fn("AgentstackCli.diff")(function* (input) {
    const result = yield* run([
      "--manifest-dir",
      input.workspaceRoot,
      "diff",
      "--json",
      "--scope",
      input.scope,
    ]).pipe(
      Effect.match({
        onFailure: (error) =>
          isBinaryNotFound(error) ? ({ _tag: "NotFound" } as const) : ({ _tag: "Failed" } as const),
        onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
      }),
    );
    const report = result._tag === "Success" ? parseDiffReport(result.result.stdout) : null;
    return {
      installed: result._tag !== "NotFound",
      report,
      ...negotiate(report),
      checkedAt: yield* Clock.currentTimeMillis,
    };
  });

  const setupPlan: AgentstackCli["Service"]["setupPlan"] = Effect.fn("AgentstackCli.setupPlan")(
    function* (input) {
      const result = yield* run(["--manifest-dir", input.workspaceRoot, "init", "--plan"]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
        }),
      );
      const plan = result._tag === "Success" ? parseSetupPlan(result.result.stdout) : null;
      return {
        installed: result._tag !== "NotFound",
        plan,
        ...negotiate(plan),
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  const restoreInventory: AgentstackCli["Service"]["restoreInventory"] = Effect.fn(
    "AgentstackCli.restoreInventory",
  )(function* (input) {
    const result = yield* run(["--manifest-dir", input.workspaceRoot, "restore", "--json"]).pipe(
      Effect.match({
        onFailure: (error) =>
          isBinaryNotFound(error) ? ({ _tag: "NotFound" } as const) : ({ _tag: "Failed" } as const),
        onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
      }),
    );
    const inventory =
      result._tag === "Success" ? parseRestoreInventory(result.result.stdout) : null;
    return {
      installed: result._tag !== "NotFound",
      inventory,
      ...negotiate(inventory),
      checkedAt: yield* Clock.currentTimeMillis,
    };
  });

  const action: AgentstackCli["Service"]["action"] = Effect.fn("AgentstackCli.action")(
    function* (input) {
      // Consent binding (fail closed, before anything spawns): a trust grant
      // must carry the digest of the surface the user reviewed. Absence
      // usually means an older agentstack preview (no surface_digest yet) or
      // an older client — either way the grant is refused with the reason,
      // never downgraded to a bare `--yes`.
      if (input.action === "trust-grant") {
        const digest = input.consentedDigest;
        if (digest === undefined || !CONSENT_DIGEST_RE.test(digest)) {
          return {
            ok: false,
            message:
              digest === undefined
                ? "trust needs the reviewed surface digest — update the agentstack CLI (this one's preview has no surface_digest) or re-open the review"
                : "trust was given a malformed surface digest — re-open the review and try again",
          };
        }
      }
      // Setup-apply is plan-bound the same way: the reviewed plan_digest must
      // be present and well-formed, or nothing spawns. Absence usually means an
      // older `init --plan` (no plan_digest) or an older client.
      if (input.action === "setup-apply") {
        const digest = input.planDigest;
        if (digest === undefined || !CONSENT_DIGEST_RE.test(digest)) {
          return {
            ok: false,
            message:
              digest === undefined
                ? "setup needs the reviewed plan digest — update the agentstack CLI (this one's plan has no plan_digest) or re-open setup"
                : "setup was given a malformed plan digest — re-open setup and try again",
          };
        }
      }
      // Restore-write is id-bound: refuse anything that isn't a plausible
      // ledger id before it reaches argv.
      if (input.action === "restore-write") {
        const id = input.restoreId;
        if (id === undefined || !RESTORE_ID_RE.test(id)) {
          return {
            ok: false,
            message:
              id === undefined
                ? "undo needs the id of the change to revert — none was provided"
                : "undo was given a malformed change id — refresh and try again",
          };
        }
      }
      const result = yield* processRunner
        .run({
          command: binary,
          args: actionArgv(input.action, input.workspaceRoot, {
            consentedDigest: input.consentedDigest,
            planDigest: input.planDigest,
            restoreId: input.restoreId,
          }),
          timeout: ACTION_TIMEOUT,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: MAX_STDOUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.match({
            onFailure: (error) =>
              isBinaryNotFound(error)
                ? ({ _tag: "NotFound" } as const)
                : ({ _tag: "Failed" } as const),
            onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
          }),
        );
      if (result._tag === "NotFound") {
        return { ok: false, message: "agentstack CLI not found" };
      }
      if (result._tag === "Failed") {
        return { ok: false, message: "agentstack command could not be run" };
      }
      const r = result.result;
      if (r.timedOut) {
        return { ok: false, message: "timed out" };
      }
      // Last non-empty line of stdout (or stderr) is the human outcome.
      const lastLine = (text: string): string =>
        text
          .split("\n")
          .findLast((l) => l.trim().length > 0)
          ?.trim() ?? "";
      const ok = r.code === 0;
      const message = lastLine(r.stdout) || lastLine(r.stderr) || (ok ? "done" : "failed");
      return { ok, message: message.slice(0, 200) };
    },
  );

  return AgentstackCli.of({
    status,
    activity,
    workflow,
    workflowRun,
    trustPreview,
    diff,
    setupPlan,
    restoreInventory,
    action,
  });
});

export const layer = Layer.effect(AgentstackCli, make()).pipe(Layer.provide(ProcessRunner.layer));
