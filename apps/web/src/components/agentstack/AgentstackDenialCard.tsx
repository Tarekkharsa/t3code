import type { WorkLogEntry } from "~/session-logic";

import { AgentstackMark } from "./AgentstackMark";
import type { AgentstackDenial } from "./agentstack-logic";

function formatTime(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Inline timeline card for a tool call blocked by the AgentStack guard.
 * Replaces the generic error row so the denial reads as protection that
 * worked, not as a failure: what was blocked, by which policy rule, and
 * that nothing ran.
 */
export function AgentstackDenialCard({
  workEntry,
  denial,
}: {
  workEntry: WorkLogEntry;
  denial: AgentstackDenial;
}) {
  const time = formatTime(workEntry.createdAt);
  return (
    <div className="my-1 overflow-hidden rounded-lg border border-warning/40 bg-warning/5">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <AgentstackMark className="size-4 shrink-0 text-warning" />
        <span className="font-medium text-[13px] text-foreground">Blocked by AgentStack Guard</span>
        {denial.rule ? (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] text-warning-foreground">
            rule: {denial.rule}
          </span>
        ) : null}
        {time ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{time}</span>
        ) : null}
      </div>
      <div className="mx-3 mt-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5">
        <code className="break-all font-mono text-[11px] text-warning-foreground">
          {denial.target}
        </code>
      </div>
      <p className="px-3 pb-2.5 pt-2 text-[11px] leading-relaxed text-muted-foreground">
        Denied by {denial.source ?? "policy"} before it ran — nothing was executed and the denial is
        recorded in the AgentStack audit log.
      </p>
    </div>
  );
}
