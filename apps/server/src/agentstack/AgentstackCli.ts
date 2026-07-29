import {
  AgentstackCallEvent,
  AgentstackDiffReport,
  AgentstackDoctorReport,
  AgentstackLibraryIndex,
  AgentstackProfileEditPreview,
  AgentstackRestoreInventory,
  AgentstackSetupPlan,
  AgentstackToolsets,
  AgentstackTrustPreview,
  AgentstackWorkflowList,
  AgentstackWorkflowRun,
  AgentstackWorkflowRuns,
  AgentstackWorkflowSummary,
  type AgentstackActionKind,
  type AgentstackActionResult,
  type AgentstackActivity,
  type AgentstackDiffResult,
  type AgentstackIncompatible,
  type AgentstackLibraryIndexResult,
  type AgentstackProfileEdit,
  type AgentstackProfileEditPreviewResult,
  type AgentstackRestoreInventoryResult,
  type AgentstackSecretsDestination,
  type AgentstackSetupPlanResult,
  type AgentstackStatus,
  type AgentstackToolsetsResult,
  type AgentstackTrustPreviewResult,
  type AgentstackWorkflowData,
  type AgentstackWorkflowRunSummary,
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

import { hostHomeDir } from "../pathExpansion.ts";
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

/** A setup-plan read against a resolved workspace root. */
export interface AgentstackSetupPlanRequest {
  readonly workspaceRoot: string;
  /**
   * Which secret store to read the plan for (`init --plan --secrets <choice>`).
   * The store is bound into the returned `plan_digest`; absent → the CLI's
   * non-interactive default (keychain).
   */
  readonly secretsDestination?: AgentstackSecretsDestination;
}

/**
 * A profile-edit preview or apply against a resolved workspace root. `edit`
 * carries the parameterized change (the discriminated union the panel composed);
 * `consented` is present only on an apply — its digest maps to `--consented` and
 * is refused before spawn when malformed. `allowUnresolved` maps to
 * `--allow-unresolved` (off by default).
 */
export interface AgentstackProfileEditRequest {
  readonly workspaceRoot: string;
  readonly edit: AgentstackProfileEdit;
  readonly consented?: { readonly digest: string; readonly allowUnresolved?: boolean };
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
  /**
   * `session-start` only: the toolset (profile) name from the toolsets read.
   * A start with an absent or malformed name is refused before anything
   * spawns; the CLI independently refuses unknown profiles and unready
   * (untrusted / unpinned / drifted) surfaces.
   */
  readonly profile?: string;
  /**
   * `setup-apply` only: the secret store the reviewed plan was read for,
   * mapped to `--secrets <choice>`. Must match the store bound into
   * `planDigest`; the CLI recomputes the digest with this store and refuses a
   * mismatch. A value outside the closed set is refused before anything spawns.
   */
  readonly secretsDestination?: AgentstackSecretsDestination;
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
 * The toolset (profile) name shape allowed to reach `session start` argv.
 * Names come from the toolsets read, but re-validate at the boundary — same
 * fail-closed hygiene as the digest and ledger-id shapes (spawning is
 * args-array, so this is shape hygiene, not injection defense).
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The closed set of `--secrets` values setup-apply may forward. The contract
 * schema already constrains this to the same literal union, but re-check at the
 * argv boundary — same fail-closed hygiene as the digest/profile shapes, and it
 * keeps the guard honest if the type is ever widened upstream.
 */
export const SECRETS_DESTINATIONS: ReadonlySet<string> = new Set(["env", "keychain", "skip"]);

/**
 * The name shape allowed to reach a profile-edit argv as a toolset or capability
 * (skill/server) identifier. Same fail-closed hygiene as the other bound shapes:
 * spawning is args-array (no shell), so this bounds surface, not injection. The
 * inline-all-skills wildcard `*` is accepted separately where the CLI allows it.
 */
export const PROFILE_EDIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Defensive bounds for free-form profile-edit definition fields (git URL,
 *  command, header/env pairs, …) that reach argv verbatim. The panel's browser
 *  drives only the enroll-existing and create paths, so these are a safety net
 *  for the full contract, not the common case. */
const PROFILE_EDIT_MAX_FIELD_LEN = 4096;
const PROFILE_EDIT_MAX_LIST_LEN = 128;

function isPlainName(value: string): boolean {
  return PROFILE_EDIT_NAME_RE.test(value);
}

/**
 * A name that may become a bare TOML table key — the CLI's own rule for a
 * rename target (`validate_profile_name`), mirrored here so the panel can say
 * so before spawning rather than surfacing the CLI's refusal.
 *
 * Stricter than [`isPlainName`] on purpose: no dot, since `[profiles.a.b]`
 * would silently nest one toolset's table inside another's, and no uppercase,
 * matching the CLI.
 */
const PROFILE_BARE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function isBareKey(value: string): boolean {
  return PROFILE_BARE_KEY_RE.test(value);
}

function boundedField(value: string | undefined): boolean {
  return value === undefined || value.length <= PROFILE_EDIT_MAX_FIELD_LEN;
}

function boundedList(list: ReadonlyArray<string> | undefined): boolean {
  return (
    list === undefined ||
    (list.length <= PROFILE_EDIT_MAX_LIST_LEN &&
      list.every((v) => v.length <= PROFILE_EDIT_MAX_FIELD_LEN))
  );
}

/**
 * Fail-closed shape check for a composed profile edit before any argv is built.
 * Returns a human message when the client-supplied names/fields are out of
 * shape (the toolset and capability identifiers must be plain names; free-form
 * definition fields must stay within bounds), or null when the edit is safe to
 * pass to [`profileEditArgv`]. The CLI re-validates everything; this is the
 * cheaper boundary refusal and keeps malformed input off the argv.
 */
export function validateProfileEdit(edit: AgentstackProfileEdit): string | null {
  switch (edit.kind) {
    case "add-skill-to-profile": {
      if (!isPlainName(edit.profile)) return "toolset name looks malformed";
      if (!isPlainName(edit.name)) return "skill name looks malformed";
      if (edit.git !== undefined && edit.path !== undefined) {
        return "a skill can't have both a git source and a path";
      }
      if (
        !boundedField(edit.git) ||
        !boundedField(edit.rev) ||
        !boundedField(edit.subpath) ||
        !boundedField(edit.path)
      ) {
        return "a skill source field is too long";
      }
      return null;
    }
    case "add-server-to-profile": {
      if (!isPlainName(edit.profile)) return "toolset name looks malformed";
      if (!isPlainName(edit.name)) return "server name looks malformed";
      if (
        !boundedField(edit.url) ||
        !boundedField(edit.command) ||
        !boundedField(edit.cwd) ||
        !boundedList(edit.args) ||
        !boundedList(edit.headers) ||
        !boundedList(edit.env)
      ) {
        return "a server definition field is too long";
      }
      return null;
    }
    case "create-profile": {
      if (!isPlainName(edit.name)) return "toolset name looks malformed";
      if (edit.skills.length === 0 && edit.servers.length === 0) {
        return "pick at least one skill or server for the toolset";
      }
      if (
        edit.skills.length > PROFILE_EDIT_MAX_LIST_LEN ||
        edit.servers.length > PROFILE_EDIT_MAX_LIST_LEN
      ) {
        return "too many members for one toolset";
      }
      // `*` is the CLI's inline-all-skills wildcard (skills only); every other
      // member must be a plain capability name.
      if (!edit.skills.every((s) => s === "*" || isPlainName(s))) {
        return "a skill name looks malformed";
      }
      if (!edit.servers.every((s) => isPlainName(s))) return "a server name looks malformed";
      return null;
    }
    case "rename-profile": {
      if (!isPlainName(edit.name)) return "toolset name looks malformed";
      // The new name becomes a TOML table key in the manifest, so it is held to
      // the CLI's own bare-key rule rather than the looser plain-name shape: a
      // dot would nest one toolset's table inside another's.
      if (!isBareKey(edit.to)) {
        return "use lowercase letters, digits, '_' or '-'; start with a letter or digit";
      }
      if (edit.name === edit.to) return "that is already its name";
      return null;
    }
    case "delete-profile": {
      if (!isPlainName(edit.name)) return "toolset name looks malformed";
      return null;
    }
    case "remove-from-library": {
      // The name is the only free value: a plain capability name, never the
      // `*` wildcard (there is no "remove everything" in this closed set).
      if (!isPlainName(edit.name)) return "capability name looks malformed";
      return null;
    }
  }
}

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

/**
 * The events, or `null` when the payload could not be decoded at all.
 *
 * Deliberately not a `[]` fallback: the Activity feed has to tell "no calls
 * were brokered" apart from "we could not read the log", because only one of
 * those is a statement about what the agents did.
 */
export function readCallEvents(stdout: string): ReadonlyArray<AgentstackCallEvent> | null {
  return Option.getOrNull(decodeCallEvents(stdout))?.events ?? null;
}

const decodeWorkflowList = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackWorkflowList),
);

/**
 * The full decoded list payload (workflows + versioned envelope), or null when
 * the read is missing/unparseable. The workflow monitor negotiates
 * `features`/`schema_version` off this — the project-scoped primary read — so
 * the whole object (not just the array) has to survive decode.
 */
export function parseWorkflowListPayload(stdout: string): AgentstackWorkflowList | null {
  return Option.getOrNull(decodeWorkflowList(stdout));
}

export function parseWorkflowList(stdout: string): ReadonlyArray<AgentstackWorkflowSummary> {
  return parseWorkflowListPayload(stdout)?.workflows ?? [];
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
  Schema.fromJsonString(AgentstackWorkflowRuns),
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

const decodeToolsets = Schema.decodeUnknownOption(Schema.fromJsonString(AgentstackToolsets));

export function parseToolsets(stdout: string) {
  return Option.getOrNull(decodeToolsets(stdout));
}

const decodeRestoreInventory = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackRestoreInventory),
);

export function parseRestoreInventory(stdout: string) {
  return Option.getOrNull(decodeRestoreInventory(stdout));
}

const decodeLibraryIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackLibraryIndex),
);

export function parseLibraryIndex(stdout: string) {
  return Option.getOrNull(decodeLibraryIndex(stdout));
}

const decodeProfileEditPreview = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackProfileEditPreview),
);

export function parseProfileEditPreview(stdout: string) {
  return Option.getOrNull(decodeProfileEditPreview(stdout));
}

/**
 * The fixed argv for a profile edit — the client supplies only the composed
 * `edit` (its shape already checked by [`validateProfileEdit`]) and, on apply,
 * the consent flags. `kind` selects the CLI verb; a bare call (no `consent`) is
 * a `--preview` that writes nothing, while an apply presents the reviewed digest
 * back with `--yes --consented <digest>`. The panel never supplies a command
 * line, a scope, or a `--prune-foreign`.
 */
export function profileEditArgv(
  workspaceRoot: string,
  edit: AgentstackProfileEdit,
  consent?: { readonly digest: string; readonly allowUnresolved?: boolean },
): ReadonlyArray<string> {
  const base = ["--manifest-dir", workspaceRoot];
  // Preview is the default (nothing writes); apply is --yes + the reviewed
  // digest, optionally allowing an unresolved ${REF} through the render.
  const consentFlags = consent
    ? [
        "--yes",
        "--consented",
        consent.digest,
        ...(consent.allowUnresolved ? ["--allow-unresolved"] : []),
      ]
    : ["--preview"];
  switch (edit.kind) {
    case "add-skill-to-profile": {
      const argv = [
        ...base,
        "add-skill-to-profile",
        "--profile",
        edit.profile,
        "--name",
        edit.name,
      ];
      if (edit.git !== undefined) argv.push("--git", edit.git);
      if (edit.rev !== undefined) argv.push("--rev", edit.rev);
      if (edit.subpath !== undefined) argv.push("--subpath", edit.subpath);
      if (edit.path !== undefined) argv.push("--path", edit.path);
      return [...argv, ...consentFlags];
    }
    case "add-server-to-profile": {
      const argv = [
        ...base,
        "add-server-to-profile",
        "--profile",
        edit.profile,
        "--name",
        edit.name,
      ];
      // `--type` only for a NEW definition; omitted when enrolling an existing
      // server (the CLI's default is unused there, and both preview and apply
      // omit it identically so the digest lines up).
      if (edit.transport !== undefined) argv.push("--type", edit.transport);
      if (edit.url !== undefined) argv.push("--url", edit.url);
      if (edit.command !== undefined) argv.push("--command", edit.command);
      for (const a of edit.args ?? []) argv.push("--arg", a);
      for (const h of edit.headers ?? []) argv.push("--header", h);
      for (const e of edit.env ?? []) argv.push("--env", e);
      if (edit.cwd !== undefined) argv.push("--cwd", edit.cwd);
      return [...argv, ...consentFlags];
    }
    case "create-profile": {
      const argv = [...base, "create-profile", "--name", edit.name];
      for (const s of edit.skills) argv.push("--skill", s);
      for (const s of edit.servers) argv.push("--server", s);
      return [...argv, ...consentFlags];
    }
    case "rename-profile": {
      // Nothing renders, so `--allow-unresolved` would be inert; the consent
      // flags are the same two-step every other edit uses.
      const argv = [...base, "rename-profile", "--name", edit.name, "--to", edit.to];
      return [...argv, ...(consent ? ["--yes", "--consented", consent.digest] : ["--preview"])];
    }
    case "delete-profile": {
      const argv = [...base, "delete-profile", "--name", edit.name];
      return [...argv, ...(consent ? ["--yes", "--consented", consent.digest] : ["--preview"])];
    }
    case "remove-from-library": {
      // Machine-wide: no toolset, no scope, and nothing renders — so
      // `--allow-unresolved` (which only governs a render) is never emitted
      // here, even when the caller passes it. The only client-supplied value
      // reaching argv is the validated capability name; `--kind` is a closed
      // enum on both sides.
      const argv = [...base, "remove-from-library", "--kind", edit.group, "--name", edit.name];
      return [...argv, ...(consent ? ["--yes", "--consented", consent.digest] : ["--preview"])];
    }
  }
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
    readonly profile?: string | undefined;
    readonly secretsDestination?: string | undefined;
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
    case "setup-apply": {
      // Apply the reviewed `init --plan`. --consented-plan presents back the
      // plan_digest the user saw; the CLI writes nothing if detection changed.
      // The plan_digest also binds the secret-store choice, so forward the same
      // --secrets value the plan was read for — the CLI recomputes the digest
      // with this store and refuses on mismatch. Absent → the CLI's default
      // (keychain), matching a plan read that also omitted --secrets. The caller
      // refuses before spawn when the digest is absent/malformed or the store is
      // outside the closed set, so the "" fallback never reaches argv.
      const argv = [
        "--manifest-dir",
        workspaceRoot,
        "init",
        "--yes",
        "--consented-plan",
        bound?.planDigest ?? "",
      ];
      if (bound?.secretsDestination !== undefined) {
        argv.push("--secrets", bound.secretsDestination);
      }
      return argv;
    }
    case "restore-write":
      // Undo one ledger entry by its full hex id (validated before spawn).
      // Never `--last` — the ledger is machine-global and the panel already
      // picked the newest project-touching entry.
      //
      // No `--json` here, deliberately: an action's outcome is reduced by
      // [`lastCliLine`], and `restore --write --json` suppresses the human
      // sentence in favour of a pretty-printed object — whose last line is
      // `}`. The panel wants the sentence the terminal would have printed.
      return ["--manifest-dir", workspaceRoot, "restore", bound?.restoreId ?? "", "--write"];
    case "session-start":
      // Temporary activation of one declared toolset. The CLI's session gate
      // is fail-closed (refuses untrusted projects and unpinned/drifted
      // surfaces), so this argv can be fixed: name in, no scope, no
      // overrides. The caller refuses before spawn when the name is absent
      // or malformed, so the "" fallback never reaches a process.
      return ["--manifest-dir", workspaceRoot, "session", "start", bound?.profile ?? ""];
    case "session-end":
      // Revert the active session here — including one an interrupted panel
      // left behind (the CLI's session store survives the supervisor).
      return ["--manifest-dir", workspaceRoot, "session", "end"];
  }
}

/**
 * The last non-empty line of CLI output as the human outcome, with ANSI SGR
 * colour sequences stripped so the panel never renders raw escape codes. Shared
 * by the governed `action` and the profile-edit apply, both of which surface a
 * text outcome line (never JSON) exactly like the terminal command.
 */
function lastCliLine(text: string): string {
  return (
    text
      .replaceAll(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .findLast((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}

/**
 * The one line the panel shows as a command's outcome — taken from the stream
 * that actually carries it.
 *
 * On success that is stdout: the CLI's closing sentence. On a refusal it is
 * stderr, where the reason and the remedy live, while stdout still holds
 * whatever the command printed before it gave up. `trust` prints an entire
 * review to stdout and then bails with "…run `agentstack lock`, review the
 * result, then `agentstack trust` again"; preferring stdout there hands the
 * user the tail of a review instead of the sentence that says how to proceed.
 * The same is true of a render blocked by an unresolved `${REF}`.
 */
function outcomeLine(stdout: string, stderr: string, ok: boolean): string {
  return ok
    ? lastCliLine(stdout) || lastCliLine(stderr) || "done"
    : lastCliLine(stderr) || lastCliLine(stdout) || "failed";
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
      input: AgentstackSetupPlanRequest,
    ) => Effect.Effect<AgentstackSetupPlanResult>;
    readonly toolsets: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackToolsetsResult>;
    readonly restoreInventory: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackRestoreInventoryResult>;
    readonly libraryIndex: (
      input: AgentstackWorkspaceRequest,
    ) => Effect.Effect<AgentstackLibraryIndexResult>;
    readonly profileEditPreview: (
      input: AgentstackProfileEditRequest,
    ) => Effect.Effect<AgentstackProfileEditPreviewResult>;
    readonly profileEditApply: (
      input: AgentstackProfileEditRequest,
    ) => Effect.Effect<AgentstackActionResult>;
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
      // A failed read and an empty log are different facts, and collapsing
      // them into `events: []` makes the panel state "nothing was recorded"
      // when the truth is that it does not know. The read counts as failed
      // when the process could not run, exited non-zero, or produced output
      // that would not decode.
      const events =
        result._tag === "Success" && result.result.code === 0
          ? readCallEvents(result.result.stdout)
          : null;
      return {
        installed: result._tag !== "NotFound",
        events: events ?? [],
        // Never claimed when the binary is simply absent — that is its own
        // state, and the panel already says so.
        ...(events === null && result._tag !== "NotFound" ? { readFailed: true } : {}),
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
          ...negotiate(null),
          checkedAt: yield* Clock.currentTimeMillis,
        };
      }
      // The list is the project-scoped primary read: negotiate features and
      // schema compatibility off its payload. A failed or unparseable list
      // (older binary, malformed output) negotiates as absent -> features [].
      const listPayload =
        listResult._tag === "Success" ? parseWorkflowListPayload(listResult.result.stdout) : null;
      const workflows = listPayload?.workflows ?? [];

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
        ...negotiate(listPayload),
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
      // Read the plan for the requested secret store; the store is bound into
      // the `plan_digest`, so the apply must present it back with the same
      // `--secrets` value. Absent → the CLI's own default (keychain).
      const planArgs = ["--manifest-dir", input.workspaceRoot, "init", "--plan"];
      if (input.secretsDestination !== undefined) {
        planArgs.push("--secrets", input.secretsDestination);
      }
      const result = yield* run(planArgs).pipe(
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
        // Display only — the plan payload stays exactly as the CLI sent it,
        // because its digest is taken over those bytes.
        home: hostHomeDir(),
        ...negotiate(plan),
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  const toolsets: AgentstackCli["Service"]["toolsets"] = Effect.fn("AgentstackCli.toolsets")(
    function* (input) {
      const result = yield* run([
        "--manifest-dir",
        input.workspaceRoot,
        "use",
        "--list",
        "--json",
      ]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
        }),
      );
      const decoded = result._tag === "Success" ? parseToolsets(result.result.stdout) : null;
      return {
        installed: result._tag !== "NotFound",
        toolsets: decoded,
        ...negotiate(decoded),
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

  const libraryIndex: AgentstackCli["Service"]["libraryIndex"] = Effect.fn(
    "AgentstackCli.libraryIndex",
  )(function* (input) {
    const result = yield* run(["--manifest-dir", input.workspaceRoot, "library-index"]).pipe(
      Effect.match({
        onFailure: (error) =>
          isBinaryNotFound(error) ? ({ _tag: "NotFound" } as const) : ({ _tag: "Failed" } as const),
        onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
      }),
    );
    const index = result._tag === "Success" ? parseLibraryIndex(result.result.stdout) : null;
    return {
      installed: result._tag !== "NotFound",
      index,
      ...negotiate(index),
      checkedAt: yield* Clock.currentTimeMillis,
    };
  });

  const profileEditPreview: AgentstackCli["Service"]["profileEditPreview"] = Effect.fn(
    "AgentstackCli.profileEditPreview",
  )(function* (input) {
    // A preview writes nothing, but it still reaches argv — refuse a malformed
    // edit at the boundary and surface no preview (the panel treats a null
    // preview as "can't compose this change").
    if (validateProfileEdit(input.edit) !== null) {
      return {
        installed: true,
        preview: null,
        features: [],
        incompatible: null,
        checkedAt: yield* Clock.currentTimeMillis,
      };
    }
    const result = yield* run(profileEditArgv(input.workspaceRoot, input.edit)).pipe(
      Effect.match({
        onFailure: (error) =>
          isBinaryNotFound(error) ? ({ _tag: "NotFound" } as const) : ({ _tag: "Failed" } as const),
        onSuccess: (r) => ({ _tag: "Success", result: r }) as const,
      }),
    );
    const preview =
      result._tag === "Success" ? parseProfileEditPreview(result.result.stdout) : null;
    return {
      installed: result._tag !== "NotFound",
      preview,
      ...negotiate(preview),
      checkedAt: yield* Clock.currentTimeMillis,
    };
  });

  const profileEditApply: AgentstackCli["Service"]["profileEditApply"] = Effect.fn(
    "AgentstackCli.profileEditApply",
  )(function* (input) {
    // Fail closed, before anything spawns: the reviewed consent digest must be
    // present and well-formed, and the composed edit must be in shape. Either
    // failure refuses with a reason and never reaches a process — the CLI still
    // re-verifies the digest against the manifest bytes as the real guarantee.
    const consent = input.consented;
    if (consent === undefined || !CONSENT_DIGEST_RE.test(consent.digest)) {
      return {
        ok: false,
        message:
          consent === undefined
            ? "this change needs the reviewed digest — re-open the preview and confirm"
            : "this change was given a malformed digest — re-open the preview and try again",
      };
    }
    const shapeError = validateProfileEdit(input.edit);
    if (shapeError !== null) {
      return { ok: false, message: shapeError };
    }
    const result = yield* processRunner
      .run({
        command: binary,
        args: profileEditArgv(input.workspaceRoot, input.edit, {
          digest: consent.digest,
          ...(consent.allowUnresolved ? { allowUnresolved: true } : {}),
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
    if (result._tag === "NotFound") return { ok: false, message: "agentstack CLI not found" };
    if (result._tag === "Failed")
      return { ok: false, message: "agentstack command could not be run" };
    const r = result.result;
    if (r.timedOut) return { ok: false, message: "timed out" };
    const ok = r.code === 0;
    return { ok, message: outcomeLine(r.stdout, r.stderr, ok).slice(0, 200) };
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
        // The secret-store choice (if the client sent one) must be a member of
        // the closed set before it reaches `--secrets`. The digest binding is
        // the real guarantee; this is fail-closed shape hygiene at the boundary.
        const dest = input.secretsDestination;
        if (dest !== undefined && !SECRETS_DESTINATIONS.has(dest)) {
          return { ok: false, message: "setup was given an unknown secret-store choice" };
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
      // Session-start is name-bound: refuse anything that isn't a plausible
      // profile name before it reaches argv. The name must come from the
      // toolsets read; the CLI still refuses unknown or unready profiles.
      if (input.action === "session-start") {
        const profile = input.profile;
        if (profile === undefined || !PROFILE_NAME_RE.test(profile)) {
          return {
            ok: false,
            message:
              profile === undefined
                ? "starting a toolset needs its name — pick one from the list"
                : "toolset name looks malformed — refresh the list and try again",
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
            profile: input.profile,
            secretsDestination: input.secretsDestination,
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
      const ok = r.code === 0;
      return { ok, message: outcomeLine(r.stdout, r.stderr, ok).slice(0, 200) };
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
    toolsets,
    restoreInventory,
    libraryIndex,
    profileEditPreview,
    profileEditApply,
    action,
  });
});

export const layer = Layer.effect(AgentstackCli, make()).pipe(Layer.provide(ProcessRunner.layer));
