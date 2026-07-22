import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * Contracts for the optional AgentStack governance integration.
 *
 * AgentStack (https://github.com/Tarekkharsa/agentstack) is an external local
 * CLI that trust-gates and audits what agent CLIs may do on a machine. The
 * integration is strictly read-only and degrades to "not installed" when the
 * CLI is absent; T3 Code never writes AgentStack state.
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
