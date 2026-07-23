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

export const AgentstackDoctorReport = Schema.Struct({
  errors: Schema.Number,
  warnings: Schema.Number,
  /** trusted | drifted | untrusted — the project's trust state, when a
   *  project was checked. Absent on older CLIs (fall back to gateway prose). */
  trust: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sections: Schema.Array(AgentstackDoctorSection),
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

export const AgentstackWorkflowData = Schema.Struct({
  installed: Schema.Boolean,
  /** Every declared `[workflows.*]` entry with its admission status. */
  workflows: Schema.Array(AgentstackWorkflowSummary),
  /** The most recent workflow run's evidence, if one exists. */
  activeRun: Schema.NullOr(AgentstackWorkflowRun),
  checkedAt: Schema.Number,
});
export type AgentstackWorkflowData = typeof AgentstackWorkflowData.Type;

export const AgentstackWorkflowInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentstackWorkflowInput = typeof AgentstackWorkflowInput.Type;

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
});
export type AgentstackTrustPreview = typeof AgentstackTrustPreview.Type;

export const AgentstackTrustPreviewResult = Schema.Struct({
  installed: Schema.Boolean,
  preview: Schema.NullOr(AgentstackTrustPreview),
  checkedAt: Schema.Number,
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
});
export type AgentstackDiffReport = typeof AgentstackDiffReport.Type;

export const AgentstackDiffResult = Schema.Struct({
  installed: Schema.Boolean,
  report: Schema.NullOr(AgentstackDiffReport),
  checkedAt: Schema.Number,
});
export type AgentstackDiffResult = typeof AgentstackDiffResult.Type;

export const AgentstackDiffInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  /** Which config scope to diff: global (~) or project (repo-local). */
  scope: Schema.Literals(["global", "project"]),
});
export type AgentstackDiffInput = typeof AgentstackDiffInput.Type;

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
 * effective policy. `trust-grant` runs `agentstack trust --yes` — the UI only
 * reaches it after the review dialog rendered the actual surface (from
 * `trust --preview`), so the click is the consent that replaces the terminal
 * keystroke; the CLI still self-refuses an unpinned surface.
 */
export const AgentstackActionKind = Schema.Literals([
  "apply-project",
  "apply-global",
  "adopt-project",
  "adopt-global",
  "guard-install",
  "trust-grant",
  "trust-revoke",
]);
export type AgentstackActionKind = typeof AgentstackActionKind.Type;

export const AgentstackActionInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  action: AgentstackActionKind,
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
