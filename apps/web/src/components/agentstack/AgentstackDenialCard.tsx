import type { WorkLogEntry } from "~/session-logic";

import { useAgentstackPanelStore } from "~/agentstackPanelStore";
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
 * worked, not a failure: what was blocked, which policy dimension caught it,
 * and that nothing ran. "View in audit log" jumps the header panel to its
 * Activity tab. There is deliberately no "Allow once" — a guard denial is the
 * machine policy ceiling, which the UI cannot loosen; the affordance is shown
 * disabled so the reason is visible rather than absent.
 */
export function AgentstackDenialCard({
  workEntry,
  denial,
}: {
  workEntry: WorkLogEntry;
  denial: AgentstackDenial;
}) {
  const requestOpen = useAgentstackPanelStore((s) => s.requestOpen);
  const time = formatTime(workEntry.createdAt);
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-warning/30 bg-warning/[0.05]">
      <div className="flex items-center gap-2 border-b border-warning/[0.18] px-3.5 py-2.5">
        <AgentstackMark className="size-[15px] shrink-0 text-warning" />
        <span className="font-semibold text-[13px] text-warning">Blocked by AgentStack Guard</span>
        {denial.dimension ? (
          <span className="inline-flex h-[18px] items-center rounded bg-warning/[0.12] px-1.5 font-mono text-[10px] font-medium text-warning">
            policy: {denial.dimension}
          </span>
        ) : denial.rule ? (
          <span className="inline-flex h-[18px] items-center rounded bg-warning/[0.12] px-1.5 font-mono text-[10px] font-medium text-warning">
            rule: {denial.rule}
          </span>
        ) : null}
        {time ? (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">{time}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <code className="block break-all rounded-lg border border-black/30 bg-black/30 px-3 py-2 font-mono text-[12px] text-destructive">
          {denial.target}
        </code>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {denial.rule ? (
            <>
              Matched the <span className="font-mono text-foreground/80">{denial.rule}</span> rule
              in your {denial.source ?? "machine policy"} and was denied before it ran.
            </>
          ) : (
            <>Matched your {denial.source ?? "machine policy"} and was denied before it ran.</>
          )}{" "}
          Your working tree was not touched. The denial is recorded in the audit log.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => requestOpen("activity")}
            className="inline-flex h-[26px] items-center rounded-lg border border-border/70 bg-foreground/[0.03] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.06]"
          >
            View in audit log
          </button>
          <button
            type="button"
            disabled
            title="A guard denial is your machine policy — the ceiling no repo or UI can loosen. Edit the machine manifest to change the rule."
            className="inline-flex h-[26px] cursor-not-allowed items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground/50"
          >
            Can't be overridden here
          </button>
        </div>
      </div>
    </div>
  );
}
