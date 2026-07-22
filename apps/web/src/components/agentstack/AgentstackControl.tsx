import type {
  AgentstackActivity,
  AgentstackStatus,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { agentstackEnvironment } from "~/state/agentstack";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AgentstackMark } from "./AgentstackMark";
import {
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  type AgentstackRowLevel,
} from "./agentstack-logic";

const LEVEL_DOT: Record<AgentstackRowLevel, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
};

const OUTCOME_DOT: Record<"ok" | "error" | "denied", string> = {
  ok: "bg-success",
  denied: "bg-warning",
  error: "bg-destructive",
};

/** Poll cadence while the popover is open; nothing polls while it's closed. */
const REFRESH_MS = 5_000;

/**
 * Header control for AgentStack governance status: the mark as an icon
 * button, opening a popover with the project's live doctor overview.
 * The request names the project (and thread, for worktree threads); the
 * server resolves the workspace root and shells the local `agentstack`
 * CLI, so this works unchanged over remote connections.
 */
export function AgentstackControl({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  /** Omitted for drafts, whose thread does not exist server-side yet. */
  threadId?: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AgentstackStatus | null>(null);
  const [activity, setActivity] = useState<AgentstackActivity | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const fetchStatus = useAtomCommand(agentstackEnvironment.status, { reportFailure: false });
  const fetchActivity = useAtomCommand(agentstackEnvironment.activity, { reportFailure: false });

  const refresh = useCallback(async () => {
    const input = { projectId, ...(threadId !== undefined ? { threadId } : {}) };
    const [statusResult, activityResult] = await Promise.all([
      fetchStatus({ environmentId, input }),
      fetchActivity({ environmentId, input }),
    ]);
    if (statusResult._tag === "Success") {
      setStatus(statusResult.value);
      setUnreachable(false);
    } else {
      setUnreachable(true);
    }
    // Activity is progressive enhancement — its failure never blanks the
    // overview.
    setActivity(activityResult._tag === "Success" ? activityResult.value : null);
  }, [environmentId, fetchActivity, fetchStatus, projectId, threadId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const rows = status?.doctor ? deriveAgentstackOverviewRows(status.doctor) : [];
  const attention = rows.some((r) => r.level !== "ok");

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger render={<Button aria-label="AgentStack" size="xs" variant="outline" />}>
        <AgentstackMark className="size-3.5" />
        {attention ? (
          <span aria-hidden className="-mr-0.5 size-1.5 rounded-full bg-warning" />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[340px]" side="bottom">
        <div className="flex items-center gap-2">
          <AgentstackMark className="size-4" />
          <span className="font-semibold text-sm">AgentStack</span>
          {status?.version ? (
            <span className="text-[11px] text-muted-foreground">
              {status.version.replace(/^agentstack\s*/, "v")}
            </span>
          ) : null}
        </div>
        <div className="mt-3">
          {unreachable ? (
            <p className="text-muted-foreground text-xs">
              Couldn't check status — the t3code server didn't answer.
            </p>
          ) : status === null ? (
            <p className="text-muted-foreground text-xs">Checking…</p>
          ) : !status.installed ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              The <code className="font-mono">agentstack</code> CLI isn't installed on the machine
              running this project, so its sessions run ungoverned. Install it to get trust-gated
              MCP servers, a pre-tool-use guard, and a per-project audit log.
            </p>
          ) : status.doctor === null ? (
            <p className="text-muted-foreground text-xs">
              agentstack is installed, but <code className="font-mono">doctor</code> produced no
              readable report for this project.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((row) => (
                <li className="flex items-baseline gap-2 text-xs" key={row.key}>
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 translate-y-px self-center rounded-full",
                      LEVEL_DOT[row.level],
                    )}
                  />
                  <span className="w-16 shrink-0 font-medium text-foreground">{row.label}</span>
                  <span className="min-w-0 truncate text-muted-foreground" title={row.summary}>
                    {row.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {status?.installed && activity !== null && activity.events.length > 0 ? (
          <div className="mt-3 border-t pt-2">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Recent calls</p>
            <ul className="space-y-1">
              {deriveAgentstackActivityRows(activity.events, Date.now() / 1_000).map((row) => (
                <li className="flex items-center gap-2 text-[11px]" key={row.key}>
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", OUTCOME_DOT[row.outcome])}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate font-mono",
                      row.outcome === "denied"
                        ? "text-warning-foreground"
                        : "text-muted-foreground",
                    )}
                    title={row.label}
                  >
                    {row.label}
                  </span>
                  <span className="shrink-0 text-muted-foreground/60">{row.age}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {status?.installed && status.doctor !== null ? (
          <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground/80">
            <code className="font-mono">agentstack doctor</code> — every warning names its fix
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
