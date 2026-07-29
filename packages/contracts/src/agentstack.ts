import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * Contracts for the optional AgentStack governance integration.
 *
 * AgentStack (https://github.com/Tarekkharsa/agentstack) is an external local
 * CLI that trust-gates and audits what agent CLIs may do on a machine. The
 * integration is read-only by default and degrades to "not installed" when the
 * CLI is absent. The one exception is `AgentstackActionInput`: a small, closed
 * set of vetted governed commands the panel may trigger (fix drift, install the
 * guard). Actions are named by an enum the server maps to fixed argv — the
 * client never supplies a command line — and, by construction, none can loosen
 * effective policy (re-rendering is capped by the machine ceiling; guard install
 * only tightens). Bypassing a guard denial has no safe shape and is not offered.
 */

/**
 * The versioned envelope every UI-facing agentstack JSON read now trails with.
 * `schema_version` lets t3code detect a CLI newer than it understands;
 * `features` names the end-to-end contracts (`init-plan`, `apply-setup`,
 * `trust-consent`, …) actually usable against this binary, so the client can
 * feature-gate an action instead of firing it blindly and reading a failure.
 * Both are `optionalKey` so payloads from older CLIs (which omit them) still
 * decode — an absent envelope means "older CLI", read as `features: []`.
 */
const AgentstackEnvelopeFields = {
  schema_version: Schema.optionalKey(Schema.Number),
  features: Schema.optionalKey(Schema.Array(Schema.String)),
} as const;

/**
 * Surfaced by the server on a read whose payload declares a `schema_version`
 * higher than the client supports: the CLI speaks a contract this t3code build
 * cannot. Both version numbers are carried so the UI can say which side to
 * update. `cliSchema` is the payload's version; `supported` is
 * `SUPPORTED_AGENTSTACK_SCHEMA`.
 */
export const AgentstackIncompatible = Schema.Struct({
  cliSchema: Schema.Number,
  supported: Schema.Number,
});
export type AgentstackIncompatible = typeof AgentstackIncompatible.Type;

/**
 * Negotiation carried on each read *result* wrapper (not the raw CLI payload).
 * `features` is the decoded envelope's feature list, defaulted to `[]` for an
 * absent envelope (older CLI); `incompatible` is non-null only when the CLI's
 * schema outruns this client. Both `optionalKey` so a client can decode
 * responses from a server that predates negotiation.
 */
const AgentstackNegotiationFields = {
  features: Schema.optionalKey(Schema.Array(Schema.String)),
  incompatible: Schema.optionalKey(Schema.NullOr(AgentstackIncompatible)),
} as const;

export const AgentstackDoctorLine = Schema.Struct({
  level: Schema.String,
  msg: Schema.String,
});
export type AgentstackDoctorLine = typeof AgentstackDoctorLine.Type;

export const AgentstackDoctorSection = Schema.Struct({
  title: Schema.String,
  lines: Schema.Array(AgentstackDoctorLine),
});
export type AgentstackDoctorSection = typeof AgentstackDoctorSection.Type;

/** guard = the host pre-tool-use guard is installed; machine_policy = a
 *  restrictive machine ceiling is in force. Both are cooperative host
 *  protections, NOT a sandbox — surfaced together as the "Protected" posture. */
export const AgentstackProtection = Schema.Struct({
  guard: Schema.Boolean,
  machine_policy: Schema.Boolean,
});
export type AgentstackProtection = typeof AgentstackProtection.Type;

export const AgentstackDoctorReport = Schema.Struct({
  errors: Schema.Number,
  warnings: Schema.Number,
  /**
   * Findings that are true and worth stating but are NOT something this
   * project must repair — the CLI keeps them out of `warnings`, `state`, and
   * `next_action`, so a healthy setup carrying advisories still reads `ready`.
   * Absent on CLIs predating `doctor-advisories-v1`; gate the display on that
   * feature name rather than on this key being present.
   */
  advisories: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** trusted | drifted | untrusted — the project's trust state, when a
   *  project was checked. Absent on older CLIs (fall back to gateway prose). */
  trust: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * needs_setup | needs_attention | ready — the one-word posture the panel
   * turns into a status chip. `needs_setup` means no manifest yet (sections
   * empty). Kept a free string (not `Literals`) so a future posture still
   * decodes; absent on older CLIs, where the chip degrades to the row rollup.
   */
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** One recommended command (e.g. `agentstack secret set SEARCH_TOKEN`), or
   *  null when nothing is pending. Shown verbatim as the next step. */
  next_action: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The cooperative host-protection posture, when the CLI reports it. */
  protection: Schema.optionalKey(Schema.NullOr(AgentstackProtection)),
  sections: Schema.Array(AgentstackDoctorSection),
  ...AgentstackEnvelopeFields,
});
export type AgentstackDoctorReport = typeof AgentstackDoctorReport.Type;

/**
 * The status request names server-known entities, never a raw path: the
 * server resolves the project (or the thread's worktree) to a workspace root
 * from its own projections, so a client cannot point the AgentStack CLI at an
 * arbitrary directory.
 */
export const AgentstackStatusInput = Schema.Struct({
  projectId: ProjectId,
  /** Refines the check to the thread's worktree when the thread has one. */
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackStatusInput = typeof AgentstackStatusInput.Type;

export const AgentstackStatus = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  doctor: Schema.NullOr(AgentstackDoctorReport),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackStatus = typeof AgentstackStatus.Type;

/**
 * One brokered call from the AgentStack audit feed (`report calls --json
 * --tail`). Field names are AgentStack's wire format, kept verbatim; values
 * are privacy-safe by construction (keyed argument digests, never argument
 * values; denial details are policy rule names, failures a fixed error
 * class).
 */
export const AgentstackCallEvent = Schema.Struct({
  ts: Schema.Number,
  server: Schema.String,
  tool: Schema.String,
  outcome: Schema.Literals(["ok", "error", "denied"]),
  ms: Schema.Number,
  run: Schema.optionalKey(Schema.String),
  args_digest: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
export type AgentstackCallEvent = typeof AgentstackCallEvent.Type;

export const AgentstackActivityInput = Schema.Struct({
  projectId: ProjectId,
  /** Refines the check to the thread's worktree when the thread has one. */
  threadId: Schema.optionalKey(ThreadId),
  /** Maximum events to return; the server clamps this. */
  limit: Schema.optionalKey(Schema.Number),
});
export type AgentstackActivityInput = typeof AgentstackActivityInput.Type;

export const AgentstackActivity = Schema.Struct({
  installed: Schema.Boolean,
  /** Newest last, matching audit-log append order. */
  events: Schema.Array(AgentstackCallEvent),
  /**
   * The read itself failed — the CLI is present but `report calls` could not be
   * run or its output could not be parsed.
   *
   * Without this an unreadable log and an empty log are the same payload
   * (`events: []`), and the panel says "nothing recorded yet" — a statement
   * about the world — when the truth is that it does not know. `optionalKey`
   * so a client can still decode a payload from a server that predates it;
   * absent is read as "the read succeeded".
   */
  readFailed: Schema.optionalKey(Schema.Boolean),
  checkedAt: Schema.Number,
});
export type AgentstackActivity = typeof AgentstackActivity.Type;

// ── workflow feed (read) ─────────────────────────────────────────────────────
// Field names mirror `agentstack workflow …--json` verbatim (snake_case).

export const AgentstackWorkflowSummary = Schema.Struct({
  name: Schema.String,
  declared: Schema.Boolean,
  trusted: Schema.Boolean,
  // matches | drifted | missing | unavailable | resolve_failed — kept as a
  // free string so the CLI can report new lock states without breaking decode.
  lock_status: Schema.String,
  roles: Schema.Array(Schema.String),
  max_agents: Schema.Number,
  max_wall_seconds: Schema.Number,
});
export type AgentstackWorkflowSummary = typeof AgentstackWorkflowSummary.Type;

export const AgentstackWorkflowStep = Schema.Struct({
  step: Schema.Number,
  role: Schema.String,
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  child_run_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.Literals(["completed", "failed", "running", "spawned"]),
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optionalKey(Schema.Number),
  duration_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Recorded data-flow (D2): prior step ids whose RESULT text appears in
   *  this step's prompt — the honest "shuffle" edge, never inferred. */
  taint: Schema.optionalKey(Schema.Array(Schema.Number)),
});
export type AgentstackWorkflowStep = typeof AgentstackWorkflowStep.Type;

export const AgentstackWorkflowRun = Schema.Struct({
  run: Schema.String,
  workflow: Schema.String,
  workflow_digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  outcome: Schema.NullOr(Schema.Literals(["completed", "failed", "running"])),
  exhausted: Schema.Boolean,
  duration_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  max_agents: Schema.Number,
  max_wall_seconds: Schema.Number,
  steps: Schema.Array(AgentstackWorkflowStep),
});
export type AgentstackWorkflowRun = typeof AgentstackWorkflowRun.Type;

// One row of `agentstack workflow runs --json` — the durable run history
// read from each run's own evidence log, joined with the live registry.
// `outcome` is the CLI's honest three-state (plus `interrupted`: no terminal
// recorded and the envelope process is gone — the resumable case).
export const AgentstackWorkflowRunSummary = Schema.Struct({
  run: Schema.String,
  workflow: Schema.String,
  outcome: Schema.Literals(["completed", "failed", "running", "interrupted"]),
  exhausted: Schema.Boolean,
  resumable: Schema.Boolean,
  started_unix: Schema.Number,
  duration_ms: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  steps: Schema.Number,
});
export type AgentstackWorkflowRunSummary = typeof AgentstackWorkflowRunSummary.Type;

/**
 * The raw `agentstack workflow list --json` payload wrapper. The list is the
 * project-scoped primary workflow read, so it carries the versioned envelope —
 * this is the read the monitor negotiates `features`/`schema_version` off of.
 * Envelope keys are `optionalKey`, so an older binary that emits `{workflows}`
 * alone still decodes (envelope read as absent).
 */
export const AgentstackWorkflowList = Schema.Struct({
  workflows: Schema.Array(AgentstackWorkflowSummary),
  ...AgentstackEnvelopeFields,
});
export type AgentstackWorkflowList = typeof AgentstackWorkflowList.Type;

/**
 * The raw `agentstack workflow runs --json` payload wrapper. Carries the
 * versioned envelope for tolerance/parity with the list read; the monitor
 * negotiates off the list, not this. Envelope keys are `optionalKey` so an
 * older binary's `{runs}`-only payload still decodes.
 */
export const AgentstackWorkflowRuns = Schema.Struct({
  runs: Schema.Array(AgentstackWorkflowRunSummary),
  ...AgentstackEnvelopeFields,
});
export type AgentstackWorkflowRuns = typeof AgentstackWorkflowRuns.Type;

export const AgentstackWorkflowData = Schema.Struct({
  installed: Schema.Boolean,
  /** Every declared `[workflows.*]` entry with its admission status. */
  workflows: Schema.Array(AgentstackWorkflowSummary),
  /** The most recent workflow run's evidence, if one exists. */
  activeRun: Schema.NullOr(AgentstackWorkflowRun),
  /**
   * Recorded run history, newest first. Optional so a client can still
   * decode responses from servers (or agentstack binaries) that predate
   * `workflow runs`; absent means "unknown", not "none".
   */
  runs: Schema.optionalKey(Schema.Array(AgentstackWorkflowRunSummary)),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackWorkflowData = typeof AgentstackWorkflowData.Type;

export const AgentstackWorkflowInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackWorkflowInput = typeof AgentstackWorkflowInput.Type;

/**
 * One recorded run's full evidence tree by id (`workflow report --json`) —
 * the click-through behind a run-history row. The id shape is re-validated
 * server-side before it reaches the CLI's argv.
 */
export const AgentstackWorkflowRunInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  /** The workflow envelope run id, e.g. `w-2572621809`. */
  runId: Schema.String,
});
export type AgentstackWorkflowRunInput = typeof AgentstackWorkflowRunInput.Type;

// ── trust preview (read) ─────────────────────────────────────────────────────
// `agentstack trust <path> --preview` — the runtime surface a human consents
// to, as data. Read-only; grants nothing. snake_case verbatim from the CLI.

export const AgentstackTrustServer = Schema.Struct({
  name: Schema.String,
  /** stdio | http | unresolvable */
  kind: Schema.String,
  /** what it runs (stdio) or contacts (http), or the resolve error. */
  target: Schema.String,
});
export type AgentstackTrustServer = typeof AgentstackTrustServer.Type;

/** One named workflow in the trust surface, with the agent roles it may spawn. */
export const AgentstackTrustWorkflow = Schema.Struct({
  name: Schema.String,
  roles: Schema.Array(Schema.String),
});
export type AgentstackTrustWorkflow = typeof AgentstackTrustWorkflow.Type;

/** One named extension in the trust surface, with what it runs/points at. */
export const AgentstackTrustExtension = Schema.Struct({
  name: Schema.String,
  target: Schema.String,
});
export type AgentstackTrustExtension = typeof AgentstackTrustExtension.Type;

export const AgentstackTrustPreview = Schema.Struct({
  path: Schema.String,
  /** trusted | drifted | untrusted */
  state: Schema.String,
  /** true when this repo was trusted before (a re-trust review). */
  re_trust: Schema.Boolean,
  servers: Schema.Array(AgentstackTrustServer),
  secrets: Schema.Array(Schema.String),
  counts: Schema.Struct({
    skills: Schema.Number,
    workflows: Schema.Number,
    extensions: Schema.Number,
    instructions: Schema.Number,
  }),
  /**
   * The complete named surface behind the counts, when a newer CLI emits it:
   * the actual skill names, workflow names (with roles), extension names (with
   * target) and instruction names a human is consenting to — rendered instead
   * of bare counts. All `optionalKey`, so an older preview (counts only) still
   * decodes and the dialog falls back to the counts.
   */
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  workflows: Schema.optionalKey(Schema.Array(AgentstackTrustWorkflow)),
  extensions: Schema.optionalKey(Schema.Array(AgentstackTrustExtension)),
  instructions: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * The previewed-surface digest (`sha256:<hex>`) — the exact value a
   * consent-bound grant must present back as `--consented-digest`, so "a
   * human reviewed this exact surface" is CLI-enforced. Optional so previews
   * from agentstack binaries that predate consent binding still decode;
   * absent means grants from this UI must be refused, not that consent is
   * optional.
   */
  surface_digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ...AgentstackEnvelopeFields,
});
export type AgentstackTrustPreview = typeof AgentstackTrustPreview.Type;

export const AgentstackTrustPreviewResult = Schema.Struct({
  installed: Schema.Boolean,
  preview: Schema.NullOr(AgentstackTrustPreview),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackTrustPreviewResult = typeof AgentstackTrustPreviewResult.Type;

export const AgentstackTrustInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackTrustInput = typeof AgentstackTrustInput.Type;

// ── drift preview (read) ─────────────────────────────────────────────────────
// `agentstack diff --json --scope <global|project>` — the exact change a
// re-render would make, as data, so the panel can show it before any write.
// Read-only. snake_case verbatim from the CLI. A subset of the CLI's output is
// modelled; excess keys (profile, owner_refreshes, the top-level `kept` tuple)
// are stripped on decode.

export const AgentstackDiffTarget = Schema.Struct({
  /** CLI id, e.g. `claude-code`. */
  id: Schema.String,
  display: Schema.String,
  /** The native config file this target renders to. */
  path: Schema.String,
  /** True when a re-render would rewrite this file (real, actionable drift). */
  changed: Schema.Boolean,
  /** Unified-diff text of the pending change; "" when unchanged. */
  diff: Schema.String,
  /**
   * True when this file changed *outside* agentstack since our last write —
   * the CLI's own "hand-edited" signal, and the same one `doctor` reports as
   * "edited on disk since last apply". Distinct from `changed`, which is also
   * true when the manifest simply moved ahead of a rendered file. Only the
   * former is somebody's edit; saying so about the latter accuses the user of
   * something they did not do. `optionalKey` so payloads from CLIs that
   * predate the field still decode (absent → we make no claim about cause).
   */
  hand_edited: Schema.optionalKey(Schema.Boolean),
  /**
   * Servers on disk that a default render *keeps* (spares) because another
   * setup applied them — `apply` never removes these without `--prune-foreign`,
   * which this integration never runs.
   */
  kept: Schema.Array(Schema.String),
});
export type AgentstackDiffTarget = typeof AgentstackDiffTarget.Type;

export const AgentstackDiffReport = Schema.Struct({
  /** global | project — the scope this diff was computed for. */
  scope: Schema.String,
  /** Count of targets with `changed: true`. Zero means a re-render is a no-op. */
  drifted: Schema.Number,
  targets: Schema.Array(AgentstackDiffTarget),
  /** Defensive: absent on some versions; degrades to []. */
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  ...AgentstackEnvelopeFields,
});
export type AgentstackDiffReport = typeof AgentstackDiffReport.Type;

export const AgentstackDiffResult = Schema.Struct({
  installed: Schema.Boolean,
  report: Schema.NullOr(AgentstackDiffReport),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackDiffResult = typeof AgentstackDiffResult.Type;

export const AgentstackDiffInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  /** Which config scope to diff: global (~) or project (repo-local). */
  scope: Schema.Literals(["global", "project"]),
});
export type AgentstackDiffInput = typeof AgentstackDiffInput.Type;

// ── setup plan (read) ────────────────────────────────────────────────────────
// `agentstack init --plan` — a read-only preview of what a first-time setup
// would import, as data, so the panel can show it in plain language before any
// write. snake_case verbatim from the CLI. The apply that follows presents back
// `plan_digest`; the CLI refuses if detection no longer digests to it.

/** One coding tool the CLI detected on the machine, with its evidence:
 *  whether the binary is on PATH and the exact native config files detection
 *  read. Both optional so a CLI predating Stage 1.2 still decodes. */
export const AgentstackSetupDetected = Schema.Struct({
  id: Schema.String,
  display: Schema.String,
  bin_on_path: Schema.optionalKey(Schema.Boolean),
  configs: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AgentstackSetupDetected = typeof AgentstackSetupDetected.Type;

/** One native file a follow-up apply will manage, in user terms — which CLI,
 *  which file, which scope ("project" | "global"), and what renders there
 *  (e.g. "MCP servers", "settings"). */
export const AgentstackSetupDestination = Schema.Struct({
  id: Schema.String,
  display: Schema.String,
  scope: Schema.String,
  path: Schema.String,
  writes: Schema.Array(Schema.String),
});
export type AgentstackSetupDestination = typeof AgentstackSetupDestination.Type;

/** One MCP server the plan would import into the new manifest. */
export const AgentstackSetupServer = Schema.Struct({
  name: Schema.String,
  /** stdio | http | … */
  kind: Schema.String,
  /** what it runs (stdio) or contacts (http). */
  target: Schema.String,
});
export type AgentstackSetupServer = typeof AgentstackSetupServer.Type;

/** A name defined by more than one detected tool — surfaced so the user knows
 *  the import picks one definition. */
export const AgentstackSetupConflict = Schema.Struct({
  name: Schema.String,
  other_definitions: Schema.Number,
});
export type AgentstackSetupConflict = typeof AgentstackSetupConflict.Type;

/** A secret the setup will reference but not store — the user still provides
 *  the value via `agentstack secret set <reference>`. */
export const AgentstackSetupSecret = Schema.Struct({
  reference: Schema.String,
  origin: Schema.String,
});
export type AgentstackSetupSecret = typeof AgentstackSetupSecret.Type;

/**
 * Where setup stores the token values it lifts out of imported configs:
 * `env` (a gitignored `.env` next to the manifest), `keychain` (the OS
 * keychain), or `skip` (write only `${REF}` placeholders — the user provides
 * values later). Mirrors the CLI's `--secrets` enum. The plan's `plan_digest`
 * binds this choice, so a change re-reads the plan (to get a digest bound to
 * the new choice) and the apply presents that digest back with the same
 * `--secrets` value — the CLI refuses a mismatch.
 */
export const AgentstackSecretsDestination = Schema.Literals(["env", "keychain", "skip"]);
export type AgentstackSecretsDestination = typeof AgentstackSecretsDestination.Type;

export const AgentstackSetupPlan = Schema.Struct({
  path: Schema.String,
  /** The manifest file the setup would create/manage. */
  manifest_path: Schema.String,
  already_initialized: Schema.Boolean,
  detected: Schema.Array(AgentstackSetupDetected),
  servers: Schema.Array(AgentstackSetupServer),
  /** Tool ids whose settings would be imported. */
  settings_from: Schema.Array(Schema.String),
  conflicts: Schema.Array(AgentstackSetupConflict),
  secrets: Schema.Array(AgentstackSetupSecret),
  /** Where secret values will live (e.g. `keychain`). */
  secrets_destination: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Native files apply will manage after setup (absent on older CLIs). */
  destinations: Schema.optionalKey(Schema.Array(AgentstackSetupDestination)),
  /**
   * `sha256:<hex>` over the reviewed plan. The apply presents it back as
   * `--consented-plan`; the CLI refuses if detection changed since. Optional
   * so a CLI that predates plan binding still decodes — but without it, apply
   * from this UI must be refused (the setup button disables), not downgraded.
   */
  plan_digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ...AgentstackEnvelopeFields,
});
export type AgentstackSetupPlan = typeof AgentstackSetupPlan.Type;

export const AgentstackSetupPlanResult = Schema.Struct({
  installed: Schema.Boolean,
  plan: Schema.NullOr(AgentstackSetupPlan),
  /**
   * The host's home directory, for display only. The CLI returns absolute
   * paths because they are a machine contract and the plan digest is taken
   * over exactly what it sent — so the payload is never rewritten. The panel
   * uses this to render `~/…` instead of a repeated home prefix down a 360px
   * column. Optional so an older server still decodes.
   */
  home: Schema.optionalKey(Schema.String),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackSetupPlanResult = typeof AgentstackSetupPlanResult.Type;

export const AgentstackSetupPlanInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  /**
   * Which secret store the plan should be read for (mapped to `init --plan
   * --secrets <choice>`). The store is bound into the returned `plan_digest`,
   * so the panel re-reads when the user changes it. Absent → the CLI's own
   * non-interactive default (keychain), for older clients that don't send it.
   */
  secretsDestination: Schema.optionalKey(AgentstackSecretsDestination),
});
export type AgentstackSetupPlanInput = typeof AgentstackSetupPlanInput.Type;

// ── restore inventory (read) ─────────────────────────────────────────────────
// `agentstack restore --json` — the machine-global undo ledger. `touches_project`
// marks entries whose files live under this workspace; the panel's Undo picks
// the newest such entry that is not already undone, never a blind `--last`.

export const AgentstackRestoreEntry = Schema.Struct({
  /** Full hex id — the value the undo write must present back. */
  id: Schema.String,
  short_id: Schema.optionalKey(Schema.String),
  time_unix: Schema.Number,
  /** project | global — the scope of the recorded change. */
  scope: Schema.String,
  /** Human one-liner, e.g. "1 file · claude-code, codex". */
  summary: Schema.String,
  undone: Schema.Boolean,
  /** True when this entry's files live under the current workspace. */
  touches_project: Schema.Boolean,
});
export type AgentstackRestoreEntry = typeof AgentstackRestoreEntry.Type;

export const AgentstackRestoreBackup = Schema.Struct({
  adapter: Schema.String,
  scope: Schema.String,
  path: Schema.String,
});
export type AgentstackRestoreBackup = typeof AgentstackRestoreBackup.Type;

export const AgentstackRestoreInventory = Schema.Struct({
  /** Newest first, matching the CLI's inventory order. */
  entries: Schema.Array(AgentstackRestoreEntry),
  adapter_backups: Schema.optionalKey(Schema.Array(AgentstackRestoreBackup)),
  ...AgentstackEnvelopeFields,
});
export type AgentstackRestoreInventory = typeof AgentstackRestoreInventory.Type;

export const AgentstackRestoreInventoryResult = Schema.Struct({
  installed: Schema.Boolean,
  inventory: Schema.NullOr(AgentstackRestoreInventory),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackRestoreInventoryResult = typeof AgentstackRestoreInventoryResult.Type;

export const AgentstackRestoreInventoryInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackRestoreInventoryInput = typeof AgentstackRestoreInventoryInput.Type;

// ── toolsets (read) ──────────────────────────────────────────────────────────
// `agentstack use --list --json` — every declared profile ("toolset" in the
// UI) with its resolved selection, readiness, and — under `sessions-v1` —
// whether it is temporarily active here. The session state comes from the
// CLI's own store on every read, which is what makes interrupted-session
// recovery honest: a reopened panel renders the truth, not its own memory.

export const AgentstackToolsetBlocker = Schema.Struct({
  name: Schema.String,
  /** One actionable reason (e.g. "unpinned — run `agentstack lock`"). */
  reason: Schema.String,
});
export type AgentstackToolsetBlocker = typeof AgentstackToolsetBlocker.Type;

export const AgentstackToolset = Schema.Struct({
  name: Schema.String,
  skills: Schema.Array(Schema.String),
  servers: Schema.Array(Schema.String),
  harness: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Everything the profile references is pinned and matching. */
  pinned: Schema.Boolean,
  /** Active session here uses this profile. Absent on an older CLI. */
  active: Schema.optionalKey(Schema.Boolean),
  blockers: Schema.Array(AgentstackToolsetBlocker),
});
export type AgentstackToolset = typeof AgentstackToolset.Type;

export const AgentstackActiveSession = Schema.Struct({
  profile: Schema.String,
  scope: Schema.String,
  started_unix: Schema.Number,
});
export type AgentstackActiveSession = typeof AgentstackActiveSession.Type;

export const AgentstackToolsets = Schema.Struct({
  path: Schema.String,
  /**
   * Absolute path to the manifest FILE this project loads — the source of
   * truth the panel offers to open.
   *
   * `path` above is the project base; the manifest inside it may be at
   * `.agentstack/agentstack.toml` (preferred) or a legacy root
   * `agentstack.toml`, and only the CLI's own layout resolution knows which
   * without guessing. Optional for version tolerance: an older binary omits
   * it and the panel simply doesn't offer to open anything.
   */
  manifest_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Project trust state: `trusted`, `drifted`, or `untrusted`. */
  trust: Schema.String,
  profiles: Schema.Array(AgentstackToolset),
  /** The active session here, or null/absent when none (or an older CLI). */
  session: Schema.optionalKey(Schema.NullOr(AgentstackActiveSession)),
  ...AgentstackEnvelopeFields,
});
export type AgentstackToolsets = typeof AgentstackToolsets.Type;

export const AgentstackToolsetsResult = Schema.Struct({
  installed: Schema.Boolean,
  toolsets: Schema.NullOr(AgentstackToolsets),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackToolsetsResult = typeof AgentstackToolsetsResult.Type;

export const AgentstackToolsetsInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackToolsetsInput = typeof AgentstackToolsetsInput.Type;

// ── library index (read) ─────────────────────────────────────────────────────
// `agentstack library-index` — the central-library catalog (skills + servers)
// plus the existing toolset names, for the panel's library browser. A pure read:
// nothing resolves, renders, or executes and no secret is touched, so it is safe
// regardless of project trust (adding and activating are separately digest-gated
// and fail closed). snake_case verbatim from the CLI; rides the versioned
// envelope carrying the `profiles-edit-v1` feature.

export const AgentstackLibrarySkill = Schema.Struct({
  name: Schema.String,
  /** Best-effort one-liner from the user's own central-library SKILL.md; null
   *  for inline manifest skills (names only — their bodies are project content,
   *  which the panel can `explain` for detail rather than surface here). */
  description: Schema.NullOr(Schema.String),
  /** `library` (central library) | `manifest` (inline in this project). */
  origin: Schema.String,
  /** True when the current manifest already defines this skill. */
  in_manifest: Schema.Boolean,
});
export type AgentstackLibrarySkill = typeof AgentstackLibrarySkill.Type;

export const AgentstackLibraryServer = Schema.Struct({
  name: Schema.String,
  /** Where a library server came from (e.g. `consolidated:github`); null for an
   *  inline manifest server or when unknown. Optional for version tolerance. */
  provenance: Schema.optionalKey(Schema.NullOr(Schema.String)),
  origin: Schema.String,
  in_manifest: Schema.Boolean,
});
export type AgentstackLibraryServer = typeof AgentstackLibraryServer.Type;

export const AgentstackLibraryIndex = Schema.Struct({
  skills: Schema.Array(AgentstackLibrarySkill),
  servers: Schema.Array(AgentstackLibraryServer),
  /** Existing toolset (profile) names — the "add to toolset" targets. */
  profiles: Schema.Array(Schema.String),
  ...AgentstackEnvelopeFields,
});
export type AgentstackLibraryIndex = typeof AgentstackLibraryIndex.Type;

export const AgentstackLibraryIndexResult = Schema.Struct({
  installed: Schema.Boolean,
  index: Schema.NullOr(AgentstackLibraryIndex),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackLibraryIndexResult = typeof AgentstackLibraryIndexResult.Type;

export const AgentstackLibraryIndexInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackLibraryIndexInput = typeof AgentstackLibraryIndexInput.Type;

// ── profile edits (preview + apply) ──────────────────────────────────────────
// The parameterized, digest-bound toolset mutations behind the panel's library
// browser: enroll a skill/server into a toolset, or create a new toolset from
// existing/library capabilities. Each follows the apply-setup two-phase shape —
// a `--preview` read returns an enveloped `consent_digest` over the intended
// change AND the current manifest bytes; the apply presents it back with
// `--yes --consented <digest>` and the CLI refuses on any drift before writing a
// byte. The server maps each `kind` to a fixed argv (the client never supplies a
// command line); `kind` is both the discriminator and the CLI verb name. Every
// mutation runs manifest → re-lock → re-render and fails closed on an unresolved
// `${REF}` (the manifest keeps the `${REF}`, never a value; the render blocks).

/**
 * Enroll or define a skill in a toolset. `git` or `path` (mutually exclusive)
 * define a new `[skills.<name>]`; with neither, an existing library/inline skill
 * is enrolled by bare `name`. The target toolset must already exist.
 */
export const AgentstackAddSkillEdit = Schema.Struct({
  kind: Schema.Literal("add-skill-to-profile"),
  profile: Schema.String,
  name: Schema.String,
  git: Schema.optionalKey(Schema.String),
  rev: Schema.optionalKey(Schema.String),
  subpath: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
});
export type AgentstackAddSkillEdit = typeof AgentstackAddSkillEdit.Type;

/**
 * Enroll or define a server in a toolset. Any wire field (`url`/`command`/…)
 * defines a new `[servers.<name>]`; with none, an existing library/inline server
 * is enrolled by bare `name`. Header/env `Key=Value` values may carry `${REF}`
 * (never resolved in the panel — secrets never serialize).
 */
export const AgentstackAddServerEdit = Schema.Struct({
  kind: Schema.Literal("add-server-to-profile"),
  profile: Schema.String,
  name: Schema.String,
  /** stdio | http — the transport for a NEW server definition (`--type`).
   *  Omitted when enrolling an existing server (the CLI default is unused). */
  transport: Schema.optionalKey(Schema.Literals(["http", "stdio"])),
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  headers: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
});
export type AgentstackAddServerEdit = typeof AgentstackAddServerEdit.Type;

/**
 * Create a new toolset from existing/library skills and servers (bare names;
 * `*` is the inline-all-skills wildcard the CLI accepts). At least one member.
 */
export const AgentstackCreateProfileEdit = Schema.Struct({
  kind: Schema.Literal("create-profile"),
  name: Schema.String,
  skills: Schema.Array(Schema.String),
  servers: Schema.Array(Schema.String),
});
export type AgentstackCreateProfileEdit = typeof AgentstackCreateProfileEdit.Type;

/**
 * Remove a skill or MCP server from the MACHINE-WIDE central library — the
 * curation half of the library browser. Unlike the `add-*` edits this touches no
 * manifest, no lockfile, and renders nothing: it drops the library's copy, which
 * every project referencing that name shares. It is recoverable by construction
 * (the CLI moves the entry to `~/.agentstack/lib/.trash`, restorable with
 * `agentstack lib trash --restore <id> --write`), and still digest-bound — here
 * the digest covers the library index bytes, since that is the state that moves.
 * `group` is the library collection; only `library`-origin rows may be removed
 * (an inline manifest capability is project content, removed a different way).
 */
export const AgentstackRemoveFromLibraryEdit = Schema.Struct({
  kind: Schema.Literal("remove-from-library"),
  group: Schema.Literals(["skill", "server"]),
  name: Schema.String,
});
export type AgentstackRemoveFromLibraryEdit = typeof AgentstackRemoveFromLibraryEdit.Type;

/**
 * Change one toolset's membership as a single batch: every add and every
 * removal in one manifest write, under one `consent_digest`, followed by one
 * re-lock and one re-render.
 *
 * This is what lets the browser be a set of ticks rather than a list of Add
 * buttons. The per-capability verbs have no inverse — `remove-from-library` is
 * machine-wide and deletes the capability itself — so un-ticking had nothing to
 * call. Removal here ends a MEMBERSHIP: the capability stays declared and stays
 * in the library.
 *
 * The preview returns the resulting `skills`/`servers` as well as the deltas,
 * so the digest binds the end state the user was actually looking at. Gate on
 * `profiles-edit-batch-v1`.
 */
export const AgentstackEditProfileEdit = Schema.Struct({
  kind: Schema.Literal("edit-profile"),
  profile: Schema.String,
  addSkills: Schema.Array(Schema.String),
  removeSkills: Schema.Array(Schema.String),
  addServers: Schema.Array(Schema.String),
  removeServers: Schema.Array(Schema.String),
});
export type AgentstackEditProfileEdit = typeof AgentstackEditProfileEdit.Type;

/**
 * Rename a toolset, keeping its members. Renames the manifest entry and nothing
 * else — nothing is rendered, so no `${REF}` is resolved.
 *
 * The CLI refuses rather than cascading: a toolset name is also a workflow's
 * role name, and a role is that workflow's reviewed authority request (pinned
 * in the lockfile, hashed into its grant digest), so renaming one out from
 * under a workflow would rewrite a consented surface and strand any parked run.
 * A live session refuses too — the gateway resolves that fence by name on every
 * call, so renaming underneath it removes the fence rather than moving it.
 * Gate on `toolset-rename-v1`.
 */
export const AgentstackRenameProfileEdit = Schema.Struct({
  kind: Schema.Literal("rename-profile"),
  name: Schema.String,
  to: Schema.String,
});
export type AgentstackRenameProfileEdit = typeof AgentstackRenameProfileEdit.Type;

/**
 * Delete a toolset. Its servers and skills stay declared in the manifest and
 * stay in the library — a toolset is a selection over them, not their owner.
 *
 * Refuses on the same cases as a rename, plus the last toolset: with none
 * declared, the render and the proxied server surface both fall back to every
 * server in the manifest, so that delete widens rather than tidies. Gate on
 * `toolset-delete-v1`.
 */
export const AgentstackDeleteProfileEdit = Schema.Struct({
  kind: Schema.Literal("delete-profile"),
  name: Schema.String,
});
export type AgentstackDeleteProfileEdit = typeof AgentstackDeleteProfileEdit.Type;

export const AgentstackProfileEdit = Schema.Union([
  AgentstackAddSkillEdit,
  AgentstackAddServerEdit,
  AgentstackCreateProfileEdit,
  AgentstackEditProfileEdit,
  AgentstackRenameProfileEdit,
  AgentstackDeleteProfileEdit,
  AgentstackRemoveFromLibraryEdit,
]);
export type AgentstackProfileEdit = typeof AgentstackProfileEdit.Type;

/**
 * One decoded profile-edit preview: the CLI's enveloped change description plus
 * the `consent_digest` the apply must echo back. Per-verb detail rides in
 * `skill`/`server`/`skills`/`servers` (all optionalKey), so one shape decodes
 * every verb's preview and older CLIs that omit a block still decode.
 */
export const AgentstackProfileEditPreview = Schema.Struct({
  /** The verb this preview is for, echoed by the CLI. */
  action: Schema.String,
  /** The target toolset (add-*), or the new toolset name (create). */
  profile: Schema.optionalKey(Schema.String),
  /**
   * `sha256:<hex>` over the intended change + current manifest bytes. Absent
   * (older CLI) means the apply must be refused, not downgraded to a bare
   * `--yes` — the confirm button disables when it's null.
   */
  consent_digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The CLI's plain-language apply note (names the ${REF}-blocks-render rule). */
  note: Schema.optionalKey(Schema.String),
  skill: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      /** git | path | existing */
      source: Schema.String,
      creates_manifest_entry: Schema.Boolean,
      git: Schema.optionalKey(Schema.NullOr(Schema.String)),
      rev: Schema.optionalKey(Schema.NullOr(Schema.String)),
      subpath: Schema.optionalKey(Schema.NullOr(Schema.String)),
      path: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  server: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      creates_manifest_entry: Schema.Boolean,
      transport: Schema.optionalKey(Schema.NullOr(Schema.String)),
      url: Schema.optionalKey(Schema.NullOr(Schema.String)),
      command: Schema.optionalKey(Schema.NullOr(Schema.String)),
      args: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /** create-profile: the seeded members. */
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  servers: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * remove-from-library: what leaves the machine-wide library, where it goes,
   * and this project's stake in it. `used_by_this_project` is what turns a
   * routine tidy-up into a warning — the removal itself never edits the project,
   * so a referenced name only breaks at the next lock/activate.
   */
  removal: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.String,
      name: Schema.String,
      /** `path` | `git` for a skill; `file` for a server definition. */
      source: Schema.optionalKey(Schema.NullOr(Schema.String)),
      /** The body that moves to the trash; null for a git-backed skill (the
       *  shared store cache is never touched by a removal). */
      body: Schema.optionalKey(Schema.NullOr(Schema.String)),
      trash_id: Schema.optionalKey(Schema.String),
      trash_path: Schema.optionalKey(Schema.String),
      /** The exact `lib trash --restore …` line to undo it. */
      restore_command: Schema.optionalKey(Schema.String),
      /** `machine` — this is not a project-scoped change. */
      scope: Schema.optionalKey(Schema.String),
      used_by_this_project: Schema.optionalKey(Schema.Boolean),
      defined_inline_here: Schema.optionalKey(Schema.Boolean),
      /** Toolsets in this project that list the name. */
      profiles: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  ...AgentstackEnvelopeFields,
});
export type AgentstackProfileEditPreview = typeof AgentstackProfileEditPreview.Type;

export const AgentstackProfileEditPreviewResult = Schema.Struct({
  installed: Schema.Boolean,
  preview: Schema.NullOr(AgentstackProfileEditPreview),
  checkedAt: Schema.Number,
  ...AgentstackNegotiationFields,
});
export type AgentstackProfileEditPreviewResult = typeof AgentstackProfileEditPreviewResult.Type;

export const AgentstackProfileEditPreviewInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  edit: AgentstackProfileEdit,
});
export type AgentstackProfileEditPreviewInput = typeof AgentstackProfileEditPreviewInput.Type;

/**
 * Apply a reviewed profile edit. The `consentedDigest` from the preview is
 * mapped to `--consented`; the server refuses before spawning without a
 * well-formed one, and the CLI refuses when the manifest or the change moved
 * since the preview. The apply returns a human outcome line (`AgentstackAction
 * Result`), exactly like `setup-apply` — not JSON; the panel re-reads state
 * after.
 */
export const AgentstackProfileEditApplyInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  edit: AgentstackProfileEdit,
  consentedDigest: Schema.String,
  /** Let activation proceed past an unresolved `${REF}` (`--allow-unresolved`).
   *  Off by default — an unresolved secret blocking the render is a feature. */
  allowUnresolved: Schema.optionalKey(Schema.Boolean),
});
export type AgentstackProfileEditApplyInput = typeof AgentstackProfileEditApplyInput.Type;

// ── governed actions (write) ─────────────────────────────────────────────────

/**
 * The closed set of governed commands the panel may trigger. The server maps
 * each to fixed argv — the client never supplies a command line, a scope, or a
 * `--prune-foreign` flag (that destructive flag is never emitted from here).
 *
 * Drift is fixed by two verbs, each at an explicit scope, so the operation and
 * where it lands are both closed over server-side:
 *  - `adopt-{project,global}` runs `agentstack adopt --scope <s> --write`: keeps
 *    the on-disk hand-edit by pulling it into the manifest. It only ever writes
 *    `agentstack.toml` — it never rewrites a CLI's native config, so it can add
 *    a server to the manifest but never remove one from disk (non-destructive).
 *  - `apply-{project,global}` runs `agentstack apply --scope <s> --write`:
 *    re-renders the native config from the manifest, capped by the machine
 *    ceiling and reversible via `agentstack restore`. Without `--prune-foreign`
 *    (never passed) it keeps servers another setup applied and never touches
 *    hand-added servers no manifest tracks.
 *
 * `guard-install` only adds pre-tool-use protection; `trust-grant` /
 * `trust-revoke` grant or withdraw trust for this project. None can loosen
 * effective policy. `trust-grant` runs
 * `agentstack trust --yes --consented-digest <surface_digest>` — the digest
 * the review dialog got from `trust --preview`, so the click is the consent
 * that replaces the terminal keystroke AND the CLI itself verifies the
 * reviewed bytes are the bytes being granted (a stale or missing digest
 * refuses; an unpinned surface still self-refuses).
 */
export const AgentstackActionKind = Schema.Literals([
  "apply-project",
  "apply-global",
  "adopt-project",
  "adopt-global",
  "guard-install",
  "trust-grant",
  "trust-revoke",
  // `setup-apply` applies a reviewed `init --plan` (`init --yes
  // --consented-plan <planDigest>`); the CLI refuses if detection no longer
  // digests to it. `restore-write` undoes one ledger entry by id (`restore
  // <restoreId> --write`). Both are consent-/id-bound the same way trust-grant
  // is digest-bound: the server refuses before spawning without a valid value.
  "setup-apply",
  "restore-write",
  // `session-start` runs `agentstack session start <profile>` — temporary
  // activation of one declared toolset, fail-closed in the CLI (refuses an
  // untrusted project or an unpinned/drifted surface regardless of what any
  // UI displayed). The profile name must come from the toolsets read; the
  // server refuses a malformed name before anything spawns. `session-end`
  // runs `agentstack session end`, reverting the session — including one an
  // interrupted panel left behind.
  "session-start",
  "session-end",
]);
export type AgentstackActionKind = typeof AgentstackActionKind.Type;

export const AgentstackActionInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  action: AgentstackActionKind,
  /**
   * `trust-grant` only: the `surface_digest` from the trust preview the user
   * actually reviewed. The server maps it to `--consented-digest` and refuses
   * the grant when it is absent; the CLI refuses when it no longer matches
   * the bytes on disk. Meaningless (ignored) for every other action.
   */
  consentedDigest: Schema.optionalKey(Schema.String),
  /**
   * `setup-apply` only: the `plan_digest` from the `init --plan` the user
   * reviewed. Mapped to `--consented-plan`; the server refuses before spawning
   * when it is absent or malformed, the CLI refuses when detection changed.
   * Ignored for every other action.
   */
  planDigest: Schema.optionalKey(Schema.String),
  /**
   * `restore-write` only: the full hex `id` of the ledger entry to undo. The
   * server refuses before spawning unless it matches the id shape. Ignored for
   * every other action.
   */
  restoreId: Schema.optionalKey(Schema.String),
  /**
   * `session-start` only: the toolset (profile) name to activate, taken from
   * the toolsets read. The server refuses before spawning unless it matches
   * the profile-name shape; the CLI independently refuses unknown profiles
   * and unready surfaces. Ignored for every other action.
   */
  profile: Schema.optionalKey(Schema.String),
  /**
   * `setup-apply` only: the secret store the reviewed plan was read for,
   * mapped to `--secrets <choice>`. Must match the store bound into the
   * `planDigest` above — the CLI recomputes the digest with this store and
   * refuses on mismatch, so it is defense in depth, not the only guard.
   * Absent → the CLI's non-interactive default (keychain). Ignored for every
   * other action.
   */
  secretsDestination: Schema.optionalKey(AgentstackSecretsDestination),
});
export type AgentstackActionInput = typeof AgentstackActionInput.Type;

export const AgentstackActionResult = Schema.Struct({
  /** True when the command exited 0. */
  ok: Schema.Boolean,
  /** A short, human-readable outcome line (last line of CLI output). */
  message: Schema.String,
});
export type AgentstackActionResult = typeof AgentstackActionResult.Type;

export class AgentstackWorkspaceContextError extends Schema.TaggedErrorClass<AgentstackWorkspaceContextError>()(
  "AgentstackWorkspaceContextError",
  {
    projectId: ProjectId,
    threadId: Schema.optionalKey(ThreadId),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const thread = this.threadId ? ` / thread '${this.threadId}'` : "";
    return `Could not resolve a workspace for AgentStack status from project '${this.projectId}'${thread}.`;
  }
}
