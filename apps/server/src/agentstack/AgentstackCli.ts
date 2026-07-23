import {
  AgentstackCallEvent,
  AgentstackDiffReport,
  AgentstackDoctorReport,
  AgentstackTrustPreview,
  AgentstackWorkflowRun,
  AgentstackWorkflowRunSummary,
  AgentstackWorkflowSummary,
  type AgentstackActionKind,
  type AgentstackActionResult,
  type AgentstackActivity,
  type AgentstackDiffResult,
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

/** A read-only drift preview against a resolved workspace root, at one scope. */
export interface AgentstackDiffRequest {
  readonly workspaceRoot: string;
  readonly scope: "global" | "project";
}

/** A governed action against a resolved workspace root. */
export interface AgentstackActionRequest {
  readonly workspaceRoot: string;
  readonly action: AgentstackActionKind;
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

/** The fixed argv for each vetted action — the client never supplies one. */
function actionArgv(action: AgentstackActionKind, workspaceRoot: string): ReadonlyArray<string> {
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
      // --yes: the review dialog already showed the surface, so the UI click
      // is the consent. The CLI still self-refuses an unpinned surface.
      return ["--manifest-dir", workspaceRoot, "trust", workspaceRoot, "--yes"];
    case "trust-revoke":
      return ["--manifest-dir", workspaceRoot, "trust", workspaceRoot, "--revoke"];
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
    readonly trustPreview: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackTrustPreviewResult>;
    readonly diff: (input: AgentstackDiffRequest) => Effect.Effect<AgentstackDiffResult>;
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
          checkedAt: yield* Clock.currentTimeMillis,
        };
      }

      return {
        installed: true,
        version: yield* Cache.get(versionCache, "version"),
        doctor:
          doctorResult._tag === "Success" ? parseDoctorReport(doctorResult.result.stdout) : null,
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
    return {
      installed: result._tag !== "NotFound",
      preview: result._tag === "Success" ? parseTrustPreview(result.result.stdout) : null,
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
    return {
      installed: result._tag !== "NotFound",
      report: result._tag === "Success" ? parseDiffReport(result.result.stdout) : null,
      checkedAt: yield* Clock.currentTimeMillis,
    };
  });

  const action: AgentstackCli["Service"]["action"] = Effect.fn("AgentstackCli.action")(
    function* (input) {
      const result = yield* processRunner
        .run({
          command: binary,
          args: actionArgv(input.action, input.workspaceRoot),
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

  return AgentstackCli.of({ status, activity, workflow, trustPreview, diff, action });
});

export const layer = Layer.effect(AgentstackCli, make()).pipe(Layer.provide(ProcessRunner.layer));
