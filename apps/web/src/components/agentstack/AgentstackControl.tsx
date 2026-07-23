import type {
  AgentstackActivity,
  AgentstackStatus,
  AgentstackTrustPreviewResult,
  AgentstackWorkflowData,
  AgentstackWorkflowRun,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentstackPanelStore } from "~/agentstackPanelStore";
import { agentstackEnvironment } from "~/state/agentstack";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AgentstackMark } from "./AgentstackMark";
import {
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  deriveAgentstackPolicyRows,
  deriveAgentstackTrustBadge,
  deriveWorkflowCounts,
  deriveWorkflowStages,
  shortDigest,
  type AgentstackActionKind as ActionKind,
  type AgentstackOverviewRow,
  type AgentstackRowLevel,
  type AgentstackTrustState,
} from "./agentstack-logic";

const LEVEL_DOT: Record<AgentstackRowLevel, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

const OUTCOME_DOT: Record<"ok" | "error" | "denied", string> = {
  ok: "bg-success",
  denied: "bg-warning",
  error: "bg-destructive",
};

const TRUST_BADGE: Record<AgentstackTrustState, { dot: string; text: string; bg: string } | null> =
  {
    trusted: { dot: "bg-success", text: "text-success", bg: "bg-success/10" },
    inert: { dot: "bg-warning", text: "text-warning", bg: "bg-warning/10" },
    drifted: { dot: "bg-destructive", text: "text-destructive", bg: "bg-destructive/10" },
    unknown: null,
  };

const STEP_DOT: Record<string, string> = {
  completed: "bg-success",
  failed: "bg-destructive",
  running: "bg-warning animate-pulse",
  spawned: "bg-muted-foreground/50",
};

/** Poll cadence while the popover is open; nothing polls while it's closed. */
const REFRESH_MS = 5_000;

type Tab = "overview" | "workflow" | "activity" | "policy";

type ActionState =
  | { phase: "idle" }
  | { phase: "confirm"; action: ActionKind }
  | { phase: "running"; action: ActionKind }
  | { phase: "done"; ok: boolean; message: string };

const ACTION_META: Record<ActionKind, { label: string; confirm: string }> = {
  apply: {
    label: "Fix drift",
    confirm:
      "Re-render every CLI config from the manifest. Capped by machine policy and reversible with agentstack restore.",
  },
  "guard-install": {
    label: "Enable guard",
    confirm:
      "Install the pre-tool-use guard into every detected CLI, machine-wide. Only adds protection; reversible with guard uninstall.",
  },
};

function fmtDuration(ms: number | undefined | null): string | null {
  if (ms == null || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Header control for AgentStack governance: an icon button opening a tabbed
 * popover (Overview / Workflow / Activity / Policy) with the project's live
 * state. The request names the project (and thread, for worktree threads); the
 * server resolves the workspace root and shells the local `agentstack` CLI, so
 * this works unchanged over remote connections. Reads are read-only; the only
 * writes are a closed set of vetted governed actions behind a confirm step.
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
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<AgentstackStatus | null>(null);
  const [activity, setActivity] = useState<AgentstackActivity | null>(null);
  const [workflow, setWorkflow] = useState<AgentstackWorkflowData | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [actionState, setActionState] = useState<ActionState>({ phase: "idle" });
  const [reviewing, setReviewing] = useState(false);

  const fetchStatus = useAtomCommand(agentstackEnvironment.status, { reportFailure: false });
  const fetchActivity = useAtomCommand(agentstackEnvironment.activity, { reportFailure: false });
  const fetchWorkflow = useAtomCommand(agentstackEnvironment.workflow, { reportFailure: false });
  const fetchTrustPreview = useAtomCommand(agentstackEnvironment.trustPreview, {
    reportFailure: false,
  });
  const runAction = useAtomCommand(agentstackEnvironment.action, { reportFailure: false });

  const input = useMemo(
    () => ({ projectId, ...(threadId !== undefined ? { threadId } : {}) }),
    [projectId, threadId],
  );

  const refresh = useCallback(async () => {
    const [statusResult, activityResult, workflowResult] = await Promise.all([
      fetchStatus({ environmentId, input }),
      fetchActivity({ environmentId, input }),
      fetchWorkflow({ environmentId, input }),
    ]);
    if (statusResult._tag === "Success") {
      setStatus(statusResult.value);
      setUnreachable(false);
    } else {
      setUnreachable(true);
    }
    setActivity(activityResult._tag === "Success" ? activityResult.value : null);
    setWorkflow(workflowResult._tag === "Success" ? workflowResult.value : null);
  }, [environmentId, fetchStatus, fetchActivity, fetchWorkflow, input]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, refresh]);

  // React to "open me on tab X" requests from elsewhere (e.g. a guard-denial
  // card's "View in audit log"). The nonce makes repeat requests re-fire.
  const panelOpenNonce = useAgentstackPanelStore((s) => s.openNonce);
  const panelRequestedTab = useAgentstackPanelStore((s) => s.requestedTab);
  useEffect(() => {
    if (panelOpenNonce === 0) return;
    setTab(panelRequestedTab);
    setOpen(true);
  }, [panelOpenNonce, panelRequestedTab]);

  const onAction = useCallback(
    async (action: ActionKind) => {
      setActionState({ phase: "running", action });
      const result = await runAction({ environmentId, input: { ...input, action } });
      if (result._tag === "Success") {
        setActionState({ phase: "done", ok: result.value.ok, message: result.value.message });
      } else {
        setActionState({ phase: "done", ok: false, message: "The action could not be run." });
      }
      void refresh();
    },
    [environmentId, runAction, input, refresh],
  );

  const loadPreview = useCallback(async () => {
    const r = await fetchTrustPreview({ environmentId, input });
    return r._tag === "Success" ? r.value : null;
  }, [environmentId, fetchTrustPreview, input]);

  const onTrust = useCallback(
    async (action: "trust-grant" | "trust-revoke") => {
      const r = await runAction({ environmentId, input: { ...input, action } });
      void refresh();
      return r._tag === "Success"
        ? r.value
        : { ok: false, message: "The action could not be run." };
    },
    [environmentId, runAction, input, refresh],
  );

  const activeRun =
    workflow?.activeRun && workflow.activeRun.outcome === "running" ? workflow.activeRun : null;

  const trust = status?.doctor ? deriveAgentstackTrustBadge(status.doctor) : null;
  const trustBadge = trust ? TRUST_BADGE[trust.state] : null;

  const overviewRows: AgentstackOverviewRow[] = useMemo(() => {
    if (!status?.doctor) return [];
    let wfRow: AgentstackOverviewRow | undefined;
    if (workflow?.installed) {
      const list = workflow.workflows;
      const allReady =
        list.length > 0 && list.every((w) => w.trusted && w.lock_status === "matches");
      wfRow = {
        key: "workflows",
        label: "Workflows",
        summary: activeRun
          ? `${activeRun.workflow} running`
          : list.length === 0
            ? "none declared"
            : allReady
              ? `${list.length} declared · pinned & trusted`
              : `${list.length} declared · review pending`,
        level: activeRun ? "warn" : list.length === 0 ? "muted" : allReady ? "ok" : "warn",
      };
    }
    return deriveAgentstackOverviewRows(status.doctor, wfRow);
  }, [status, workflow, activeRun]);

  const anyAttention = overviewRows.some((r) => r.level === "warn" || r.level === "error");

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setActionState({ phase: "idle" });
          setReviewing(false);
        }
      }}
      open={open}
    >
      <PopoverTrigger render={<Button aria-label="AgentStack" size="xs" variant="outline" />}>
        <AgentstackMark className="size-3.5" />
        {activeRun ? (
          <span aria-hidden className="-mr-0.5 size-1.5 rounded-full bg-warning animate-pulse" />
        ) : anyAttention ? (
          <span aria-hidden className="-mr-0.5 size-1.5 rounded-full bg-warning" />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[400px] p-0" side="bottom">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
          <AgentstackMark className="size-[22px]" />
          <span className="font-semibold text-sm text-foreground">AgentStack</span>
          {status?.version ? (
            <span className="text-[11px] text-muted-foreground">
              {status.version.replace(/^agentstack\s*/, "v")}
            </span>
          ) : null}
          {trust && trustBadge ? (
            <button
              type="button"
              onClick={() => setReviewing(true)}
              title="Review this repo's trust surface"
              className={cn(
                "ml-auto inline-flex h-5 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-opacity hover:opacity-80",
                trustBadge.text,
                trustBadge.bg,
              )}
            >
              <span className={cn("size-[5px] rounded-full", trustBadge.dot)} />
              {trust.label}
            </button>
          ) : null}
        </div>

        {/* Live workflow strip */}
        {activeRun ? (
          <button
            type="button"
            onClick={() => setTab("workflow")}
            className="mx-3 mb-2.5 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-warning/25 bg-warning/[0.07] px-2.5 py-2 text-left"
          >
            <span className="size-[7px] shrink-0 rounded-full bg-warning animate-pulse" />
            <span className="text-xs text-foreground">
              <span className="font-semibold">{activeRun.workflow}</span> running ·{" "}
              {deriveWorkflowCounts(activeRun.steps).running} active
            </span>
            <span className="ml-auto text-xs font-medium text-warning">View agents →</span>
          </button>
        ) : null}

        {reviewing ? (
          <TrustReviewPanel
            loadPreview={loadPreview}
            onTrust={onTrust}
            onClose={() => setReviewing(false)}
          />
        ) : (
          <>
            {/* Tabs */}
            <div
              role="tablist"
              aria-label="AgentStack panel"
              className="flex items-center gap-1 border-b border-border/60 px-3 pb-2.5"
            >
              {(["overview", "workflow", "activity", "policy"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium capitalize transition-colors",
                    tab === t
                      ? "bg-accent font-semibold text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t}
                  {t === "workflow" && activeRun ? (
                    <span className="size-[5px] rounded-full bg-warning animate-pulse" />
                  ) : null}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="max-h-[420px] overflow-y-auto">
              {unreachable ? (
                <p className="px-4 py-4 text-xs text-muted-foreground">
                  Couldn't check status — the t3code server didn't answer.
                </p>
              ) : status === null ? (
                <p className="px-4 py-4 text-xs text-muted-foreground">Checking…</p>
              ) : !status.installed ? (
                <NotInstalled />
              ) : tab === "overview" ? (
                <OverviewPanel
                  rows={overviewRows}
                  doctorAvailable={status.doctor !== null}
                  actionState={actionState}
                  onRequestAction={(a) => setActionState({ phase: "confirm", action: a })}
                  onConfirm={onAction}
                  onCancel={() => setActionState({ phase: "idle" })}
                />
              ) : tab === "workflow" ? (
                <WorkflowPanel data={workflow} />
              ) : tab === "activity" ? (
                <ActivityPanel activity={activity} />
              ) : (
                <PolicyPanel doctor={status.doctor} />
              )}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border/60 bg-foreground/[0.02] px-4 py-2.5">
          <code className="font-mono text-[11px] text-muted-foreground">agentstack doctor</code>
          <span className="text-[11px] text-muted-foreground/70">
            — every warning names its fix
          </span>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function NotInstalled() {
  return (
    <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
      The <code className="font-mono">agentstack</code> CLI isn't installed on the machine running
      this project, so its sessions run ungoverned. Install it to get trust-gated MCP servers, a
      pre-tool-use guard, and a per-project audit log.
    </p>
  );
}

type TrustLoad =
  | { phase: "loading" }
  | { phase: "loaded"; result: AgentstackTrustPreviewResult }
  | { phase: "error" };

type TrustAct =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; ok: boolean; message: string };

/**
 * The trust review dialog. Renders the runtime surface the CLI reports for
 * this project (servers, secrets, category counts) and — only from here, after
 * the surface is shown — lets the user grant or revoke trust. The grant runs
 * `agentstack trust --yes`; the click is the consent that replaces the terminal
 * keystroke, and the CLI still refuses an unpinned surface (surfaced as the
 * result message). The UI never bypasses or loosens anything.
 */
function TrustReviewPanel({
  loadPreview,
  onTrust,
  onClose,
}: {
  loadPreview: () => Promise<AgentstackTrustPreviewResult | null>;
  onTrust: (action: "trust-grant" | "trust-revoke") => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<TrustLoad>({ phase: "loading" });
  const [act, setAct] = useState<TrustAct>({ phase: "idle" });

  useEffect(() => {
    let alive = true;
    void loadPreview().then((result) => {
      if (!alive) return;
      setLoad(result ? { phase: "loaded", result } : { phase: "error" });
    });
    return () => {
      alive = false;
    };
  }, [loadPreview]);

  const run = async (action: "trust-grant" | "trust-revoke") => {
    setAct({ phase: "running" });
    const r = await onTrust(action);
    setAct({ phase: "done", ok: r.ok, message: r.message });
    // Re-pull the preview so the state line reflects the new trust status.
    const result = await loadPreview();
    if (result) setLoad({ phase: "loaded", result });
  };

  const preview = load.phase === "loaded" ? load.result.preview : null;
  const state = preview?.state;
  const running = act.phase === "running";

  return (
    <div className="max-h-[440px] overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2">
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          ← Back
        </button>
        <span className="text-xs font-semibold text-foreground">Trust review</span>
      </div>

      {load.phase === "loading" ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">Loading review…</p>
      ) : preview === null ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
          Couldn't load the trust review — the CLI didn't return one for this project.
        </p>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {state === "trusted"
              ? "This repo is trusted at its current bytes. Editing the manifest or lockfile re-gates it."
              : state === "drifted"
                ? "This repo was trusted, but its manifest or lockfile changed since — re-review and re-trust."
                : "This repo is inert until trusted. Review what auto-mode may run and contact, then consent."}
            {preview.re_trust && state !== "trusted" ? " You trusted it before." : ""}
          </p>

          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
              Servers ({preview.servers.length})
            </p>
            {preview.servers.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">none</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {preview.servers.map((srv) => (
                  <li key={srv.name} className="text-[11px] leading-relaxed">
                    <span className="font-semibold text-foreground">{srv.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {srv.kind === "stdio"
                        ? "runs"
                        : srv.kind === "http"
                          ? "contacts"
                          : "unresolvable —"}
                    </span>{" "}
                    <code className="break-all font-mono text-muted-foreground/90">
                      {srv.target}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {preview.secrets.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">Secrets:</span>{" "}
              {preview.secrets.join(", ")}
            </p>
          ) : null}

          {(() => {
            const c = preview.counts;
            const extra = [
              c.skills ? `${c.skills} skill(s)` : null,
              c.workflows ? `${c.workflows} workflow(s)` : null,
              c.extensions ? `${c.extensions} extension(s)` : null,
              c.instructions ? `${c.instructions} instruction(s)` : null,
            ].filter(Boolean);
            return extra.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">Also declares:</span>{" "}
                {extra.join(" · ")}
              </p>
            ) : null;
          })()}

          <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
            Full line-by-line review:{" "}
            <code className="font-mono">agentstack trust {preview.path}</code> in a terminal.
          </p>

          {act.phase === "done" ? (
            <div
              className={cn(
                "rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
                act.ok
                  ? "border-success/30 bg-success/[0.06]"
                  : "border-destructive/30 bg-destructive/[0.06]",
              )}
            >
              <span className={cn("font-semibold", act.ok ? "text-success" : "text-destructive")}>
                {act.ok ? "Done" : "Couldn't complete"}
              </span>
              {" — "}
              <span className="break-words font-mono text-muted-foreground">{act.message}</span>
            </div>
          ) : null}

          <div className="flex items-center gap-2 pt-0.5">
            {state === "trusted" ? (
              <button
                type="button"
                disabled={running}
                onClick={() => run("trust-revoke")}
                className="inline-flex h-7 items-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive disabled:opacity-60"
              >
                {running ? "Revoking…" : "Revoke trust"}
              </button>
            ) : (
              <button
                type="button"
                disabled={running}
                onClick={() => run("trust-grant")}
                className="inline-flex h-7 items-center rounded-lg border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success disabled:opacity-60"
              >
                {running ? "Trusting…" : "Trust this repo"}
              </button>
            )}
            <button
              type="button"
              disabled={running}
              onClick={onClose}
              className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground disabled:opacity-60"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OverviewPanel({
  rows,
  doctorAvailable,
  actionState,
  onRequestAction,
  onConfirm,
  onCancel,
}: {
  rows: AgentstackOverviewRow[];
  doctorAvailable: boolean;
  actionState: ActionState;
  onRequestAction: (a: ActionKind) => void;
  onConfirm: (a: ActionKind) => void;
  onCancel: () => void;
}) {
  if (!doctorAvailable) {
    return (
      <p className="px-4 py-4 text-xs text-muted-foreground">
        agentstack is installed, but <code className="font-mono">doctor</code> produced no readable
        report for this project.
      </p>
    );
  }
  return (
    <div className="flex flex-col p-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2.5 rounded-lg px-2.5 py-[7px]">
          <span className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[row.level])} />
          <span className="w-[76px] shrink-0 text-[12.5px] font-semibold text-foreground">
            {row.label}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={row.summary}
          >
            {row.summary}
          </span>
          {row.action ? (
            <button
              type="button"
              onClick={() => onRequestAction(row.action!)}
              className="shrink-0 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning transition-colors hover:bg-warning/20"
            >
              {ACTION_META[row.action].label}
            </button>
          ) : null}
        </div>
      ))}
      {actionState.phase !== "idle" ? (
        <ActionConfirm state={actionState} onConfirm={onConfirm} onCancel={onCancel} />
      ) : null}
    </div>
  );
}

function ActionConfirm({
  state,
  onConfirm,
  onCancel,
}: {
  state: ActionState;
  onConfirm: (a: ActionKind) => void;
  onCancel: () => void;
}) {
  if (state.phase === "done") {
    return (
      <div
        className={cn(
          "mx-1 mt-1.5 rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
          state.ok
            ? "border-success/30 bg-success/[0.06] text-muted-foreground"
            : "border-destructive/30 bg-destructive/[0.06] text-muted-foreground",
        )}
      >
        <span className={cn("font-semibold", state.ok ? "text-success" : "text-destructive")}>
          {state.ok ? "Done" : "Failed"}
        </span>
        {" — "}
        <span className="break-words font-mono">{state.message}</span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-2 text-muted-foreground/70 underline-offset-2 hover:underline"
        >
          dismiss
        </button>
      </div>
    );
  }
  const action = state.phase === "confirm" || state.phase === "running" ? state.action : "apply";
  const running = state.phase === "running";
  return (
    <div className="mx-1 mt-1.5 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2.5">
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        {ACTION_META[action].confirm}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={running}
          onClick={() => onConfirm(action)}
          className="inline-flex h-6 items-center rounded-md border border-warning/40 bg-warning/15 px-2.5 text-[11px] font-semibold text-warning disabled:opacity-60"
        >
          {running ? "Running…" : `Run ${ACTION_META[action].label.toLowerCase()}`}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={onCancel}
          className="inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function WorkflowPanel({ data }: { data: AgentstackWorkflowData | null }) {
  if (data === null) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">Checking workflows…</p>;
  }
  if (data.activeRun && data.activeRun.outcome === "running") {
    return <WorkflowMonitor run={data.activeRun} />;
  }
  if (data.workflows.length === 0) {
    return (
      <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        No workflows declared. A <code className="font-mono">[workflows.*]</code> entry in the
        manifest defines a governed, pinned workflow — each step a locked run.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="px-1 pb-1 text-[11px] text-muted-foreground">
        {data.workflows.length} declared · each step a locked run
      </p>
      {data.workflows.map((w) => (
        <div
          key={w.name}
          className="flex items-center gap-2 rounded-lg border border-border/50 bg-foreground/[0.02] px-3 py-2"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-xs font-semibold text-foreground">{w.name}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {w.roles.join(" · ") || "no roles"} · ≤{w.max_agents} agents
            </span>
          </div>
          <span
            className={cn(
              "inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10px] font-semibold",
              w.trusted ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
            )}
          >
            {w.trusted ? "trusted" : "inert"}
          </span>
          <span
            className={cn(
              "inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10px] font-medium",
              w.lock_status === "matches"
                ? "bg-muted-foreground/10 text-muted-foreground"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {w.lock_status === "matches" ? "locked" : w.lock_status}
          </span>
        </div>
      ))}
    </div>
  );
}

function WorkflowMonitor({ run }: { run: AgentstackWorkflowRun }) {
  const { stages, labelled } = deriveWorkflowStages(run.steps);
  const counts = deriveWorkflowCounts(run.steps);
  const pinned = shortDigest(run.workflow_digest ?? undefined);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
        <span className="size-[7px] rounded-full bg-warning animate-pulse" />
        <span className="text-[13px] font-semibold text-foreground">{run.workflow}</span>
        {pinned ? (
          <code className="font-mono text-[10px] text-muted-foreground">{pinned}</code>
        ) : null}
        <span className="ml-auto inline-flex h-[18px] items-center rounded bg-success/10 px-1.5 text-[10px] font-semibold text-success">
          every step: locked run
        </span>
      </div>
      <div className="flex flex-col gap-1 px-3 pb-2">
        {stages.map((stage) => (
          <div key={stage.key}>
            <div className="flex items-center gap-2 py-1.5">
              <span className="text-[11px] font-bold tracking-wide text-muted-foreground">
                {stage.title}
              </span>
              <span className="h-px flex-1 bg-border/60" />
            </div>
            <div className="ml-1 flex flex-col gap-1.5 border-l-2 border-warning/25 pl-3">
              {stage.steps.map((s) => {
                const dur = fmtDuration(s.duration_ms);
                return (
                  <div
                    key={s.step}
                    className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-foreground/[0.02] px-2.5 py-2"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        STEP_DOT[s.state] ?? "bg-muted-foreground/50",
                      )}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {s.label ?? `step ${s.step}`}
                      </span>
                      <span className="truncate text-[10.5px] text-muted-foreground">
                        {s.state}
                        {s.tool_calls != null ? ` · ${s.tool_calls} tool calls` : ""}
                        {dur ? ` · ${dur}` : ""}
                      </span>
                    </div>
                    <span className="inline-flex h-4 shrink-0 items-center rounded bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
                      {s.role}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-border/60 bg-foreground/[0.02] px-3 py-2 text-[11px]">
        <span className="text-muted-foreground">
          <span className="font-semibold text-success">{counts.done} done</span> ·{" "}
          <span className="font-semibold text-warning">{counts.running} running</span>
        </span>
        <span className="text-muted-foreground/70">
          roles can only narrow · ceilings frozen at spawn
        </span>
      </div>
      {!labelled ? (
        <p className="px-3 pb-2.5 pt-1 text-[10px] text-muted-foreground/60">
          Stage grouping follows step labels — a script convention, not enforced structure.
        </p>
      ) : null}
    </div>
  );
}

function ActivityPanel({ activity }: { activity: AgentstackActivity | null }) {
  const rows =
    activity && activity.events.length > 0
      ? deriveAgentstackActivityRows(activity.events, Date.now() / 1_000)
      : [];
  if (rows.length === 0) {
    return (
      <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        No brokered calls recorded for this project yet. Every tool call the gateway brokers lands
        here with a keyed argument digest — never the values.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 p-2">
      {rows.map((row) => (
        <li className="flex items-center gap-2 px-1 text-[11px]" key={row.key}>
          <span className={cn("size-1.5 shrink-0 rounded-full", OUTCOME_DOT[row.outcome])} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono",
              row.outcome === "denied" ? "text-warning" : "text-muted-foreground",
            )}
            title={row.label}
          >
            {row.label}
          </span>
          <span className="shrink-0 text-muted-foreground/60">{row.age}</span>
        </li>
      ))}
    </ul>
  );
}

function PolicyPanel({ doctor }: { doctor: AgentstackStatus["doctor"] }) {
  const rows = doctor ? deriveAgentstackPolicyRows(doctor) : [];
  if (rows.length === 0) {
    return (
      <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        The machine policy is the ceiling every session runs under — no repo can loosen it.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      {rows.map((row) => (
        <div key={row.key} className="flex items-start gap-2.5">
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", LEVEL_DOT[row.level])} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
              {row.title}
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">{row.msg}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
