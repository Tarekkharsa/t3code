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
 * worked, not a failure. Renders the full denial contract (Stage 1.4):
 * what was blocked, which boundary blocked it, what it protects, one exact
 * safe next action, and a Details disclosure with the matching rule and the
 * honest enforcement limits. There is deliberately no "Allow once" — a guard
 * denial is the machine policy ceiling, which the UI cannot loosen; the
 * affordance is shown disabled so the reason is visible rather than absent.
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
  // What this rule protects, honestly derived from what the denial names: a
  // policy dimension is a machine-ceiling boundary; a bare built-in rule is
  // the destructive-command list.
  const protects = denial.dimension
    ? `the machine ${denial.dimension} boundary — a ceiling no repo or UI can loosen`
    : "files and history that can't be recovered once a destructive command runs";
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-warning/30 bg-warning/[0.05]">
      <div className="flex items-center gap-2 border-b border-warning/[0.18] px-3.5 py-2.5">
        <AgentstackMark className="size-[15px] shrink-0 text-warning" />
        <span className="font-semibold text-[13px] text-warning">Blocked by AgentStack Guard</span>
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
          Protecting: {protects}. Your working tree was not touched.
        </p>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground/80">Safe next step:</span> if you meant
          this, run the command yourself in a terminal — the guard gates agent commands, not yours.
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
        <details className="rounded-lg border border-border/40 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            Details — matching rule and enforcement limits
          </summary>
          <div className="flex flex-col gap-1 pb-1 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {denial.dimension ? (
              <span>
                Dimension: <code className="font-mono">policy.{denial.dimension}</code>
              </span>
            ) : null}
            {denial.rule ? (
              <span>
                Rule: <code className="font-mono">{denial.rule}</code>
              </span>
            ) : null}
            <span>Source: {denial.source ?? "machine policy"}</span>
            <span>
              To change the rule, edit the machine manifest (
              <code className="font-mono">~/.agentstack/agentstack.toml</code>) — the denial is
              recorded in the audit log.
            </span>
            <span className="text-muted-foreground/60">
              Coverage: a cooperative pre-tool-use hook on this machine. It gates agent tool calls
              before they run; it is not a sandbox and does not confine other processes.
            </span>
          </div>
        </details>
      </div>
    </div>
  );
}
