import type {
  AgentstackActivity,
  AgentstackDiffReport,
  AgentstackDiffResult,
  AgentstackDiffTarget,
  AgentstackIncompatible,
  AgentstackLibraryIndexResult,
  AgentstackProfileEdit,
  AgentstackProfileEditPreview,
  AgentstackProfileEditPreviewResult,
  AgentstackRestoreInventoryResult,
  AgentstackSecretsDestination,
  AgentstackSetupPlan,
  AgentstackSetupPlanResult,
  AgentstackStatus,
  AgentstackToolsetsResult,
  AgentstackTrustPreviewResult,
  AgentstackWorkflowData,
  AgentstackWorkflowRun,
  AgentstackWorkflowRunSummary,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useAgentstackPanelStore } from "~/agentstackPanelStore";
import { agentstackEnvironment } from "~/state/agentstack";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AgentstackMark } from "./AgentstackMark";
import {
  agentstackFeatureKnownMissing,
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  deriveAgentstackPolicyRows,
  deriveAgentstackShareFacts,
  deriveAgentstackProtectionRows,
  deriveAgentstackStatusChip,
  deriveAgentstackTrustBadge,
  deriveToolsetRows,
  deriveWorkflowCounts,
  deriveWorkflowStages,
  filterAgentstackLibraryItems,
  hasAgentstackFeature,
  matchAgentstackNextAction,
  selectAgentstackUndoEntry,
  shortDigest,
  shortenAgentstackPath,
  shortenAgentstackPathsIn,
  type AgentstackActionKind as ActionKind,
  type AgentstackOverviewRow,
  type AgentstackRowLevel,
  type AgentstackTrustState,
} from "./agentstack-logic";

/** End-to-end contract names the CLI advertises in its read envelope. */
const FEATURE_APPLY_SETUP = "apply-setup";
const FEATURE_RESTORE_LAST = "restore-last";
const FEATURE_TRUST_CONSENT = "trust-consent";
const FEATURE_SESSIONS = "sessions-v1";
/** The library browser + digest-bound toolset edits (add-to-toolset, new
 *  toolset). When the CLI doesn't advertise it, the affordances stay hidden. */
const FEATURE_PROFILES_EDIT = "profiles-edit-v1";
/** Removing a capability from the machine-wide central library (recoverable —
 *  the CLI moves it to the library trash). Advertised separately from the
 *  toolset edits, so the Remove affordance only appears on a CLI that has it. */
const FEATURE_LIBRARY_REMOVE = "library-remove-v1";
/** Structured workflow observation — the enveloped `workflow list`/`runs` reads
 *  the monitor consumes. Absent on legacy binaries (monitor still renders from
 *  whatever the reads return); a CLI that positively advertises other contracts
 *  but not this one is surfaced as "observation unavailable" in the section. */
const FEATURE_WORKFLOW_OBSERVE = "workflow-observe-v1";
/** Advisory findings: true and worth stating, but nothing this project must
 *  repair — the CLI keeps them out of `warnings`/`state`/`next_action`.
 *  Without this gate the panel drops them silently (our level match falls
 *  through to `ok`), so the CLI would report "1 note" while the panel showed
 *  nothing — two surfaces telling different amounts of truth about one
 *  project. Gated on the name, never sniffed off the field being present. */
const FEATURE_DOCTOR_ADVISORIES = "doctor-advisories-v1";

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
  // History-only state: no terminal recorded and the envelope process is
  // gone — the run is resumable, not live, so no pulse.
  interrupted: "bg-warning",
};

/** Poll cadence while the popover is open; nothing polls while it's closed. */
const REFRESH_MS = 5_000;

type Tab = "overview" | "workflow" | "activity" | "policy" | "share";

/**
 * The advanced views behind the Overview (Stage 1.4): beginner navigation is
 * the four jobs on the Overview itself (Setup / Toolset / Status / Undo);
 * these open one level deeper with a back row. The `policy` id is kept for
 * store compatibility — it renders as "More protection".
 */
const ADVANCED_VIEWS: Record<Exclude<Tab, "overview">, { title: string; hint: string }> = {
  share: { title: "Share this setup", hint: "what travels, and what never does" },
  policy: { title: "More protection", hint: "stronger modes, honest coverage" },
  activity: { title: "Activity", hint: "every brokered call, newest first" },
  workflow: { title: "Workflows", hint: "governed multi-agent runs" },
};

type ActionState =
  | { phase: "idle" }
  | { phase: "confirm"; action: ActionKind }
  | { phase: "running"; action: ActionKind }
  | { phase: "done"; ok: boolean; message: string };

const ACTION_META: Record<ActionKind, { label: string; confirm: string }> = {
  "adopt-project": {
    label: "Keep edits",
    confirm:
      "Pull the on-disk hand-edits into this project's manifest. Only writes agentstack.toml — never rewrites or removes anything in a CLI's own config.",
  },
  "adopt-global": {
    label: "Keep edits",
    confirm:
      "Pull the on-disk hand-edits into this project's manifest at global scope. Only writes agentstack.toml — never rewrites or removes anything in a CLI's own config.",
  },
  "apply-project": {
    label: "Re-render",
    confirm:
      "Re-render this project's CLI config from the manifest. Overwrites hand-edits; keeps servers other setups applied and never prunes. Reversible with agentstack restore.",
  },
  "apply-global": {
    label: "Re-render",
    confirm:
      "Re-render the global CLI config from this manifest. Overwrites hand-edits; keeps servers other setups applied and never prunes. Reversible with agentstack restore.",
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

/** Compact relative age from a unix-seconds start: `45s`, `12m`, `3h`, `2d`. */
function fmtAgo(startedUnix: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - startedUnix);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86_400)}d`;
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
  const [toolsets, setToolsets] = useState<AgentstackToolsetsResult | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [actionState, setActionState] = useState<ActionState>({ phase: "idle" });
  const [reviewing, setReviewing] = useState(false);
  const [reviewingDrift, setReviewingDrift] = useState(false);
  const [browsingLibrary, setBrowsingLibrary] = useState(false);
  // The 1c expanded monitor: which run it shows, and (for recorded runs) the
  // evidence fetched for it. A live target reads the polled activeRun instead.
  const [monitorTarget, setMonitorTarget] = useState<{
    runId: string;
    summary: AgentstackWorkflowRunSummary | null;
  } | null>(null);
  const [monitorFetched, setMonitorFetched] = useState<AgentstackWorkflowRun | null>(null);

  const fetchStatus = useAtomCommand(agentstackEnvironment.status, { reportFailure: false });
  const fetchActivity = useAtomCommand(agentstackEnvironment.activity, { reportFailure: false });
  const fetchWorkflow = useAtomCommand(agentstackEnvironment.workflow, { reportFailure: false });
  const fetchWorkflowRun = useAtomCommand(agentstackEnvironment.workflowRun, {
    reportFailure: false,
  });
  const fetchTrustPreview = useAtomCommand(agentstackEnvironment.trustPreview, {
    reportFailure: false,
  });
  const fetchDiff = useAtomCommand(agentstackEnvironment.diff, { reportFailure: false });
  const fetchSetupPlan = useAtomCommand(agentstackEnvironment.setupPlan, { reportFailure: false });
  const fetchRestoreInventory = useAtomCommand(agentstackEnvironment.restoreInventory, {
    reportFailure: false,
  });
  const fetchToolsets = useAtomCommand(agentstackEnvironment.toolsets, { reportFailure: false });
  const fetchLibraryIndex = useAtomCommand(agentstackEnvironment.libraryIndex, {
    reportFailure: false,
  });
  const previewEdit = useAtomCommand(agentstackEnvironment.profileEditPreview, {
    reportFailure: false,
  });
  const applyEdit = useAtomCommand(agentstackEnvironment.profileEditApply, {
    reportFailure: false,
  });
  const runAction = useAtomCommand(agentstackEnvironment.action, { reportFailure: false });

  const input = useMemo(
    () => ({ projectId, ...(threadId !== undefined ? { threadId } : {}) }),
    [projectId, threadId],
  );

  const refresh = useCallback(async () => {
    const [statusResult, activityResult, workflowResult, toolsetsResult] = await Promise.all([
      fetchStatus({ environmentId, input }),
      fetchActivity({ environmentId, input }),
      fetchWorkflow({ environmentId, input }),
      fetchToolsets({ environmentId, input }),
    ]);
    if (statusResult._tag === "Success") {
      setStatus(statusResult.value);
      setUnreachable(false);
    } else {
      setUnreachable(true);
    }
    setActivity(activityResult._tag === "Success" ? activityResult.value : null);
    setWorkflow(workflowResult._tag === "Success" ? workflowResult.value : null);
    setToolsets(toolsetsResult._tag === "Success" ? toolsetsResult.value : null);
  }, [environmentId, fetchStatus, fetchActivity, fetchWorkflow, fetchToolsets, input]);

  useEffect(() => {
    // The monitor dialog keeps polling alive after the popover closes, so a
    // live run's step tree stays current while it's being watched.
    if (!open && monitorTarget === null) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, monitorTarget, refresh]);

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
    async (action: "trust-grant" | "trust-revoke", consentedDigest?: string) => {
      const r = await runAction({
        environmentId,
        input: {
          ...input,
          action,
          ...(consentedDigest !== undefined ? { consentedDigest } : {}),
        },
      });
      void refresh();
      return r._tag === "Success"
        ? r.value
        : { ok: false, message: "The action could not be run." };
    },
    [environmentId, runAction, input, refresh],
  );

  const loadDiff = useCallback(
    async (scope: "global" | "project") => {
      const r = await fetchDiff({ environmentId, input: { ...input, scope } });
      return r._tag === "Success" ? r.value : null;
    },
    [environmentId, fetchDiff, input],
  );

  const loadSetupPlan = useCallback(
    async (secretsDestination: AgentstackSecretsDestination) => {
      // Read the plan bound to the chosen secret store — its plan_digest
      // includes that choice, so the apply below presents the matching digest.
      const r = await fetchSetupPlan({ environmentId, input: { ...input, secretsDestination } });
      return r._tag === "Success" ? r.value : null;
    },
    [environmentId, fetchSetupPlan, input],
  );

  const loadRestoreInventory = useCallback(async () => {
    const r = await fetchRestoreInventory({ environmentId, input });
    return r._tag === "Success" ? r.value : null;
  }, [environmentId, fetchRestoreInventory, input]);

  // Apply a reviewed setup plan: the plan_digest the user saw is presented
  // back, so the CLI writes nothing if detection changed since the preview.
  const onSetupApply = useCallback(
    async (planDigest: string, secretsDestination: AgentstackSecretsDestination) => {
      const r = await runAction({
        environmentId,
        input: { ...input, action: "setup-apply", planDigest, secretsDestination },
      });
      void refresh();
      return r._tag === "Success" ? r.value : { ok: false, message: "The setup could not be run." };
    },
    [environmentId, runAction, input, refresh],
  );

  // Undo one ledger entry by its full hex id — the caller already selected the
  // newest project-touching, not-yet-undone entry.
  const onUndo = useCallback(
    async (restoreId: string) => {
      const r = await runAction({
        environmentId,
        input: { ...input, action: "restore-write", restoreId },
      });
      void refresh();
      return r._tag === "Success"
        ? r.value
        : { ok: false, message: "The change could not be undone." };
    },
    [environmentId, runAction, input, refresh],
  );

  // Temporary activation of one toolset. The name comes from the toolsets
  // read; the server refuses a malformed one before spawning and the CLI's
  // fail-closed gate is the enforcement.
  const onSessionStart = useCallback(
    async (profile: string) => {
      const r = await runAction({
        environmentId,
        input: { ...input, action: "session-start", profile },
      });
      void refresh();
      return r._tag === "Success"
        ? r.value
        : { ok: false, message: "The toolset could not be started." };
    },
    [environmentId, runAction, input, refresh],
  );

  const onSessionEnd = useCallback(async () => {
    const r = await runAction({ environmentId, input: { ...input, action: "session-end" } });
    void refresh();
    return r._tag === "Success"
      ? r.value
      : { ok: false, message: "The session could not be ended." };
  }, [environmentId, runAction, input, refresh]);

  // The library browser catalog (skills + servers + existing toolset names).
  const loadLibraryIndex = useCallback(async () => {
    const r = await fetchLibraryIndex({ environmentId, input });
    return r._tag === "Success" ? r.value : null;
  }, [environmentId, fetchLibraryIndex, input]);

  // Preview a composed toolset edit: the CLI returns the change + a consent
  // digest the apply below must echo back. Writes nothing.
  const previewProfileEdit = useCallback(
    async (edit: AgentstackProfileEdit) => {
      const r = await previewEdit({ environmentId, input: { ...input, edit } });
      return r._tag === "Success" ? r.value : null;
    },
    [environmentId, previewEdit, input],
  );

  // Apply the reviewed edit with its digest. On success the caller refreshes
  // the overview + toolsets; the ${REF}-blocked case comes back as ok:false
  // with the CLI's own line naming the missing secret.
  const applyProfileEdit = useCallback(
    async (edit: AgentstackProfileEdit, consentedDigest: string) => {
      const r = await applyEdit({ environmentId, input: { ...input, edit, consentedDigest } });
      void refresh();
      return r._tag === "Success"
        ? r.value
        : { ok: false, message: "The change could not be applied." };
    },
    [environmentId, applyEdit, input, refresh],
  );

  const runDriftAction = useCallback(
    async (action: ActionKind) => {
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

  // A live target streams from the polled activeRun; a recorded one is
  // fetched once from its evidence log (and re-fetched when a watched live
  // run finishes, to pick up the terminal outcome).
  const monitorIsLive = monitorTarget !== null && activeRun?.run === monitorTarget.runId;
  useEffect(() => {
    if (monitorTarget === null) {
      setMonitorFetched(null);
      return;
    }
    if (monitorIsLive) return;
    let cancelled = false;
    void fetchWorkflowRun({
      environmentId,
      input: { ...input, runId: monitorTarget.runId },
    }).then((result) => {
      if (!cancelled && result._tag === "Success") setMonitorFetched(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [monitorTarget, monitorIsLive, fetchWorkflowRun, environmentId, input]);
  const monitorRun = monitorTarget === null ? null : monitorIsLive ? activeRun : monitorFetched;

  const trust = status?.doctor ? deriveAgentstackTrustBadge(status.doctor) : null;
  const trustBadge = trust ? TRUST_BADGE[trust.state] : null;

  // Capability negotiation: an incompatible read (CLI schema newer than this
  // build understands) takes over the whole body; otherwise the advertised
  // feature list gates individual actions. An absent envelope (older CLI)
  // reads as no features known.
  const incompatible = status?.incompatible ?? null;
  const features = status?.features;
  const setupState = status?.doctor?.state ?? null;
  const canApplySetup = hasAgentstackFeature(features, FEATURE_APPLY_SETUP);
  const canRestore = hasAgentstackFeature(features, FEATURE_RESTORE_LAST);
  // Trust-grant keeps its digest-presence gate regardless; the feature gate is
  // only additive when the CLI actually advertises its features.
  const trustConsentMissing = agentstackFeatureKnownMissing(features, FEATURE_TRUST_CONSENT);
  const canSessions = hasAgentstackFeature(features, FEATURE_SESSIONS);
  const sessionsKnownMissing = agentstackFeatureKnownMissing(features, FEATURE_SESSIONS);
  // The library/toolset-edit affordances appear only when the CLI advertises the
  // contract — an older CLI simply doesn't show "Browse library"/"New toolset".
  const canEditProfiles = hasAgentstackFeature(features, FEATURE_PROFILES_EDIT);
  // Removal is its own contract: a CLI that can add to toolsets may predate it,
  // and a Remove button it can't honor is worse than no button.
  const canRemoveFromLibrary = hasAgentstackFeature(features, FEATURE_LIBRARY_REMOVE);
  const canReadAdvisories = hasAgentstackFeature(features, FEATURE_DOCTOR_ADVISORIES);
  // The workflow monitor negotiates off its OWN enveloped read, not the doctor
  // status: a newer CLI's workflow reads can be schema-incompatible even when
  // the status read is fine, and vice versa. Legacy binaries (no envelope) leave
  // both null/false, so the monitor renders exactly as it did before C1.3.
  const workflowIncompatible = workflow?.incompatible ?? null;
  const workflowObserveKnownMissing = agentstackFeatureKnownMissing(
    workflow?.features,
    FEATURE_WORKFLOW_OBSERVE,
  );

  const overviewRows: AgentstackOverviewRow[] = useMemo(
    () => (status?.doctor ? deriveAgentstackOverviewRows(status.doctor) : []),
    [status],
  );

  const anyAttention = overviewRows.some((r) => r.level === "warn" || r.level === "error");

  return (
    <>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setActionState({ phase: "idle" });
            setReviewing(false);
            setReviewingDrift(false);
            setBrowsingLibrary(false);
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
              onClick={() =>
                setMonitorTarget({
                  runId: activeRun.run,
                  // The history row for the live run carries its start time —
                  // that's what makes the dialog's elapsed clock honest.
                  summary: workflow?.runs?.find((r) => r.run === activeRun.run) ?? null,
                })
              }
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
              trustConsentMissing={trustConsentMissing}
            />
          ) : reviewingDrift ? (
            <DriftReviewPanel
              loadDiff={loadDiff}
              onAction={runDriftAction}
              onClose={() => setReviewingDrift(false)}
            />
          ) : browsingLibrary ? (
            <LibraryPanel
              loadIndex={loadLibraryIndex}
              preview={previewProfileEdit}
              apply={applyProfileEdit}
              canRemove={canRemoveFromLibrary}
              onClose={() => setBrowsingLibrary(false)}
            />
          ) : status?.installed && incompatible ? (
            <UpdateNeeded incompatible={incompatible} cliVersion={status.version} />
          ) : status?.installed && setupState === "needs_setup" ? (
            <SetupPanel loadPlan={loadSetupPlan} onApply={onSetupApply} canApply={canApplySetup} />
          ) : (
            <>
              {/* Advanced views carry a back row (like the review panels) so
                  the beginner surface stays a single Overview screen. */}
              {tab !== "overview" ? (
                <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2">
                  <button
                    type="button"
                    onClick={() => setTab("overview")}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    ← Back
                  </button>
                  <span className="text-xs font-semibold text-foreground">
                    {ADVANCED_VIEWS[tab].title}
                  </span>
                </div>
              ) : null}

              {/* Body */}
              <div className="max-h-[420px] overflow-y-auto">
                {unreachable ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">
                    Couldn't check status — the t3code server didn't answer.
                  </p>
                ) : status === null ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">Checking…</p>
                ) : !status.installed ? (
                  <NotInstalled onRecheck={refresh} />
                ) : tab === "overview" ? (
                  <>
                    <OverviewPanel
                      rows={overviewRows}
                      doctorAvailable={status.doctor !== null}
                      chip={deriveAgentstackStatusChip({
                        state: status.doctor?.state,
                        protection: status.doctor?.protection,
                      })}
                      nextAction={status.doctor?.next_action ?? null}
                      advisories={canReadAdvisories ? (status.doctor?.advisories ?? null) : null}
                      loadRestoreInventory={loadRestoreInventory}
                      onUndo={onUndo}
                      canRestore={canRestore}
                      toolsets={toolsets}
                      canSessions={canSessions}
                      sessionsKnownMissing={sessionsKnownMissing}
                      canEditProfiles={canEditProfiles}
                      onManageLibrary={() => setBrowsingLibrary(true)}
                      onSessionStart={onSessionStart}
                      onSessionEnd={onSessionEnd}
                      actionState={actionState}
                      onRequestAction={(a) => setActionState({ phase: "confirm", action: a })}
                      onReviewDrift={() => setReviewingDrift(true)}
                      onConfirm={onAction}
                      onCancel={() => setActionState({ phase: "idle" })}
                      onRecheck={refresh}
                    />
                    <AdvancedNav onOpen={setTab} workflowLive={activeRun !== null} />
                  </>
                ) : tab === "workflow" ? (
                  <WorkflowPanel
                    data={workflow}
                    incompatible={workflowIncompatible}
                    observeKnownMissing={workflowObserveKnownMissing}
                    cliVersion={status.version}
                    onOpenRun={(r) => setMonitorTarget({ runId: r.run, summary: r })}
                  />
                ) : tab === "activity" ? (
                  <ActivityPanel activity={activity} />
                ) : tab === "share" ? (
                  <SharePanel doctor={status.doctor} />
                ) : (
                  <ProtectionPanel
                    doctor={status.doctor}
                    actionState={actionState}
                    onRequestAction={(a) => setActionState({ phase: "confirm", action: a })}
                    onConfirm={onAction}
                    onCancel={() => setActionState({ phase: "idle" })}
                  />
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
      <WorkflowMonitorDialog
        target={monitorTarget}
        run={monitorRun}
        onClose={() => setMonitorTarget(null)}
      />
    </>
  );
}

/**
 * Shown when the `agentstack` binary can't be spawned (absent from PATH and no
 * `T3CODE_AGENTSTACK_BIN` override) — an install-guidance card, not a dead
 * panel. States what happened, why it matters, and the exact next step, then a
 * "Check again" affordance so the user can re-detect without waiting for the
 * background poll.
 */
function NotInstalled({ onRecheck }: { onRecheck: () => Promise<void> | void }) {
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await onRecheck();
    } finally {
      setRechecking(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-xs leading-relaxed text-muted-foreground">
      <p className="text-[12.5px] font-semibold text-foreground">AgentStack isn't installed</p>
      <p>
        The <code className="font-mono">agentstack</code> CLI isn't reachable on the machine running
        this project, so its sessions run ungoverned. It's a local binary — install it to get
        trust-gated MCP servers, a pre-tool-use guard, and a per-project audit log.
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
          Install
        </p>
        <p>
          Build or download it from{" "}
          <code className="break-all font-mono text-muted-foreground/90">
            github.com/Tarekkharsa/agentstack
          </code>
          , then put <code className="font-mono">agentstack</code> on your <code>PATH</code>.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
          Already installed?
        </p>
        <p>
          If <code className="font-mono">agentstack</code> is a shell function or lives off{" "}
          <code>PATH</code> (so a packaged/Finder-launched app can't see it), point the server at
          the binary:
        </p>
        <pre className="overflow-x-auto rounded bg-foreground/[0.03] p-2 font-mono text-[10.5px] text-muted-foreground">
          T3CODE_AGENTSTACK_BIN=/path/to/agentstack
        </pre>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={rechecking}
          onClick={() => void recheck()}
          className="inline-flex h-7 items-center rounded-lg border border-border/60 px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          {rechecking ? "Checking…" : "Check again"}
        </button>
        <span className="text-[10.5px] text-muted-foreground/60">
          Re-checks automatically every few seconds, too.
        </span>
      </div>
    </div>
  );
}

/**
 * `doctor` ran but its report could not be read — most often a transient race
 * with a write agentstack itself is making (setup, apply, a toolset switch),
 * where the read lands mid-write and comes back empty.
 *
 * The state used to be a bare sentence, which made a passing glitch look like
 * a dead end at the exact moment a first setup had just succeeded. It now says
 * what it is and offers the same recheck affordance as the not-installed
 * state, so the user is never stranded by one failed read.
 */
function DoctorUnreadable({ onRecheck }: { onRecheck: () => Promise<void> | void }) {
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await onRecheck();
    } finally {
      setRechecking(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-xs leading-relaxed text-muted-foreground">
      <p className="text-[12.5px] font-semibold text-foreground">Couldn't read the status</p>
      <p>
        agentstack is installed, but <code className="font-mono">doctor</code> returned no readable
        report for this project. That is usually momentary — a status read that landed while
        agentstack was writing. Any change you just made has still been applied.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={rechecking}
          onClick={() => void recheck()}
          className="inline-flex h-7 items-center rounded-lg border border-border/60 px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          {rechecking ? "Checking…" : "Check again"}
        </button>
        <span className="text-[10.5px] text-muted-foreground/60">
          Re-checks automatically every few seconds, too.
        </span>
      </div>
      <p className="text-[10.5px] text-muted-foreground/60">
        If it persists, <code className="font-mono">agentstack doctor</code> in a terminal shows the
        underlying error.
      </p>
    </div>
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
 * `agentstack trust --yes --consented-digest <surface_digest>`, presenting
 * back the digest THIS preview carried — so "the user reviewed this exact
 * surface" is verified by the CLI at grant time, not assumed from the dialog
 * having rendered. A preview without a digest (older agentstack) cannot
 * grant; the CLI still refuses an unpinned surface (surfaced as the result
 * message). The UI never bypasses or loosens anything.
 */
function TrustReviewPanel({
  loadPreview,
  onTrust,
  onClose,
  trustConsentMissing,
}: {
  loadPreview: () => Promise<AgentstackTrustPreviewResult | null>;
  onTrust: (
    action: "trust-grant" | "trust-revoke",
    consentedDigest?: string,
  ) => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
  /** True when the CLI advertises its features but not consent-bound trust. */
  trustConsentMissing: boolean;
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

  const preview = load.phase === "loaded" ? load.result.preview : null;
  const state = preview?.state;
  const running = act.phase === "running";
  // The consent digest this preview carried. `null`/absent (an agentstack
  // that predates consent binding) means the grant button stays disabled —
  // the server refuses digest-less grants, so offering the click would only
  // manufacture a failure.
  const consentDigest = preview?.surface_digest ?? null;
  // Granting needs the digest (existing gate) AND, when the CLI advertises its
  // features, the consent-bound-trust contract to be among them.
  const canGrant = consentDigest !== null && !trustConsentMissing;

  const run = async (action: "trust-grant" | "trust-revoke") => {
    setAct({ phase: "running" });
    // A grant presents back the digest of the surface being shown; revoke
    // needs no consent binding.
    const r = await onTrust(
      action,
      action === "trust-grant" && consentDigest !== null ? consentDigest : undefined,
    );
    setAct({ phase: "done", ok: r.ok, message: r.message });
    // Re-pull the preview so the state line reflects the new trust status.
    const result = await loadPreview();
    if (result) setLoad({ phase: "loaded", result });
  };

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
            // Prefer the CLI's named surface when it emits one — the actual
            // skill/workflow/extension/instruction names a human consents to,
            // not a bare count.
            const named =
              (preview.skills && preview.skills.length > 0) ||
              (preview.workflows && preview.workflows.length > 0) ||
              (preview.extensions && preview.extensions.length > 0) ||
              (preview.instructions && preview.instructions.length > 0);
            if (named) {
              return (
                <div className="flex flex-col gap-2">
                  <TrustNamedList title="Skills" items={preview.skills ?? []} />
                  {preview.workflows && preview.workflows.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
                        Workflows ({preview.workflows.length})
                      </p>
                      <ul className="flex flex-col gap-0.5">
                        {preview.workflows.map((w) => (
                          <li key={w.name} className="text-[11px] leading-relaxed">
                            <span className="font-semibold text-foreground">{w.name}</span>
                            {w.roles.length > 0 ? (
                              <span className="text-muted-foreground">
                                {" "}
                                — roles: {w.roles.join(", ")}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {preview.extensions && preview.extensions.length > 0 ? (
                    <div>
                      <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
                        Extensions ({preview.extensions.length})
                      </p>
                      <ul className="flex flex-col gap-0.5">
                        {preview.extensions.map((e) => (
                          <li key={e.name} className="text-[11px] leading-relaxed">
                            <span className="font-semibold text-foreground">{e.name}</span>{" "}
                            <code className="break-all font-mono text-muted-foreground/90">
                              {e.target}
                            </code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <TrustNamedList title="Instructions" items={preview.instructions ?? []} />
                </div>
              );
            }
            // Fall back to the counts summary for older previews.
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

          {!canGrant && state !== "trusted" ? (
            <p className="text-[11px] leading-relaxed text-warning">
              {consentDigest === null
                ? "This agentstack CLI predates consent-bound trust (its preview has no surface digest), so granting from here is disabled. Update agentstack, or trust from a terminal where the review itself is the consent."
                : "This agentstack CLI doesn't support consent-bound trust from t3code. Update agentstack, or trust from a terminal where the review itself is the consent."}
            </p>
          ) : null}

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
                disabled={running || !canGrant}
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

/** A simple named list in the trust surface (skills, instructions). */
function TrustNamedList({ title, items }: { title: string; items: ReadonlyArray<string> }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
        {title} ({items.length})
      </p>
      <ul className="flex flex-wrap gap-1">
        {items.map((name) => (
          <li
            key={name}
            className="rounded bg-muted-foreground/10 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
          >
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

type DriftLoad =
  | { phase: "loading" }
  | { phase: "loaded"; global: AgentstackDiffReport | null; project: AgentstackDiffReport | null }
  | { phase: "error" };

type DriftAct =
  | { phase: "idle" }
  | { phase: "confirm"; action: ActionKind; prompt: string }
  | { phase: "running" }
  | { phase: "done"; ok: boolean; message: string };

const DIFF_MAX = 6_000;

/** Unique server names a default render would keep (spare) across a scope. */
function keptServers(report: AgentstackDiffReport): string[] {
  return [...new Set(report.targets.flatMap((t) => t.kept))];
}

/**
 * The drift review dialog — the honest replacement for the old one-click "Fix
 * drift" (which fired a project-scope `apply` at global, foreign-kept drift and
 * changed nothing). It previews `agentstack diff --json` for both scopes and,
 * per scope, offers only actions that actually change something and never prune:
 *  - a target with a pending re-render → Keep edits (`adopt`) or Re-render (`apply`)
 *  - servers another setup applied and kept → Keep edits (`adopt`) to bring them
 *    under this manifest; `apply` is not offered because it would no-op them.
 * `--prune-foreign` is never reachable from here.
 */
function DriftReviewPanel({
  loadDiff,
  onAction,
  onClose,
}: {
  loadDiff: (scope: "global" | "project") => Promise<AgentstackDiffResult | null>;
  onAction: (action: ActionKind) => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<DriftLoad>({ phase: "loading" });
  const [act, setAct] = useState<DriftAct>({ phase: "idle" });

  const reload = useCallback(async () => {
    setLoad({ phase: "loading" });
    const [g, p] = await Promise.all([loadDiff("global"), loadDiff("project")]);
    if (g === null && p === null) {
      setLoad({ phase: "error" });
      return;
    }
    setLoad({ phase: "loaded", global: g?.report ?? null, project: p?.report ?? null });
  }, [loadDiff]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: ActionKind) => {
    setAct({ phase: "running" });
    const r = await onAction(action);
    setAct({ phase: "done", ok: r.ok, message: r.message });
    await reload();
  };

  const scopes: ReadonlyArray<{
    scope: "global" | "project";
    report: AgentstackDiffReport | null;
  }> =
    load.phase === "loaded"
      ? [
          { scope: "project", report: load.project },
          { scope: "global", report: load.global },
        ]
      : [];

  const anyContent = scopes.some(
    ({ report }) => report && (report.drifted > 0 || keptServers(report).length > 0),
  );
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
        <span className="text-xs font-semibold text-foreground">Drift review</span>
      </div>

      {load.phase === "loading" ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">Loading drift…</p>
      ) : load.phase === "error" ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
          Couldn't compute the drift preview — <code className="font-mono">agentstack diff</code>{" "}
          didn't return a report.
        </p>
      ) : !anyContent ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
          Everything is in sync — the manifest matches every rendered config, and no other setup's
          servers need attention.
        </p>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          {scopes.map(({ scope, report }) =>
            report ? (
              <DriftScopeSection
                key={scope}
                scope={scope}
                report={report}
                disabled={running}
                onPick={(action, prompt) => setAct({ phase: "confirm", action, prompt })}
              />
            ) : null,
          )}

          {act.phase === "confirm" ? (
            <div className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2.5">
              <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{act.prompt}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={running}
                  onClick={() => void run(act.action)}
                  className="inline-flex h-6 items-center rounded-md border border-warning/40 bg-warning/15 px-2.5 text-[11px] font-semibold text-warning disabled:opacity-60"
                >
                  {running ? "Running…" : `Run ${ACTION_META[act.action].label.toLowerCase()}`}
                </button>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => setAct({ phase: "idle" })}
                  className="inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : act.phase === "done" ? (
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

          <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
            Full line-by-line diff:{" "}
            <code className="font-mono">agentstack diff --scope global</code> in a terminal.
            Machine-wide global config is best managed from{" "}
            <code className="font-mono">agentstack</code> directly.
          </p>
        </div>
      )}
    </div>
  );
}

/** One scope's drift: pending re-renders (adopt/apply) and foreign-kept servers (adopt only). */
function DriftScopeSection({
  scope,
  report,
  disabled,
  onPick,
}: {
  scope: "global" | "project";
  report: AgentstackDiffReport;
  disabled: boolean;
  onPick: (action: ActionKind, prompt: string) => void;
}) {
  const changed = report.targets.filter((t) => t.changed);
  const kept = keptServers(report);
  if (changed.length === 0 && kept.length === 0) return null;

  const where = scope === "global" ? "global configs (~)" : "this repo";
  const adopt: ActionKind = scope === "global" ? "adopt-global" : "adopt-project";
  const apply: ActionKind = scope === "global" ? "apply-global" : "apply-project";

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
        {where}
      </p>

      {changed.length > 0 ? (
        <>
          {changed.map((t) => (
            <DriftTarget key={`${scope}-${t.id}`} target={t} />
          ))}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The on-disk config was hand-edited. Keep the edit, or re-render from the manifest.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onPick(
                  adopt,
                  `Keep the on-disk hand-edit in ${where} — pull it into this project's manifest. Only writes agentstack.toml; never removes anything from a CLI's config.`,
                )
              }
              className="inline-flex h-7 items-center rounded-lg border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success disabled:opacity-60"
            >
              Keep edits
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onPick(
                  apply,
                  `Re-render ${where} from the manifest. This OVERWRITES the hand-edit. Servers other setups applied are kept (never pruned). Reversible with agentstack restore.`,
                )
              }
              className="inline-flex h-7 items-center rounded-lg border border-warning/40 bg-warning/10 px-3 text-xs font-semibold text-warning disabled:opacity-60"
            >
              Re-render
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {kept.length} server{kept.length === 1 ? "" : "s"} in {where} came from another setup
            and {kept.length === 1 ? "is" : "are"} kept — this project doesn't manage{" "}
            {kept.length === 1 ? "it" : "them"} and never removes{" "}
            {kept.length === 1 ? "it" : "them"}.
          </p>
          <ul className="flex flex-wrap gap-1">
            {kept.map((name) => (
              <li
                key={`${scope}-${name}`}
                className="rounded bg-muted-foreground/10 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
              >
                {name}
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onPick(
                  adopt,
                  `Pull ${kept.length} server${
                    kept.length === 1 ? "" : "s"
                  } from another setup into THIS project's manifest so it manages ${
                    kept.length === 1 ? "it" : "them"
                  }. Only writes agentstack.toml; nothing is removed from disk.`,
                )
              }
              className="inline-flex h-7 items-center rounded-lg border border-border/60 px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              Adopt into this project
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function DriftTarget({ target }: { target: AgentstackDiffTarget }) {
  const diff = target.diff.length > DIFF_MAX ? `${target.diff.slice(0, DIFF_MAX)}\n…` : target.diff;
  return (
    <div className="rounded-lg border border-border/50 bg-foreground/[0.02] px-2.5 py-2">
      <p className="mb-1 truncate text-[11px] font-semibold text-foreground" title={target.path}>
        {target.display}
      </p>
      <p
        className="mb-1 truncate font-mono text-[10px] text-muted-foreground/70"
        title={target.path}
      >
        {target.path}
      </p>
      {diff ? (
        <pre className="max-h-40 overflow-auto rounded bg-foreground/[0.03] p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          {diff}
        </pre>
      ) : null}
    </div>
  );
}

function OverviewPanel({
  rows,
  doctorAvailable,
  chip,
  nextAction,
  advisories,
  loadRestoreInventory,
  onUndo,
  canRestore,
  toolsets,
  canSessions,
  sessionsKnownMissing,
  canEditProfiles,
  onManageLibrary,
  onSessionStart,
  onSessionEnd,
  actionState,
  onRequestAction,
  onReviewDrift,
  onConfirm,
  onCancel,
  onRecheck,
}: {
  rows: AgentstackOverviewRow[];
  doctorAvailable: boolean;
  chip: ReturnType<typeof deriveAgentstackStatusChip>;
  nextAction: string | null;
  advisories: number | null;
  loadRestoreInventory: () => Promise<AgentstackRestoreInventoryResult | null>;
  onUndo: (restoreId: string) => Promise<{ ok: boolean; message: string }>;
  canRestore: boolean;
  toolsets: AgentstackToolsetsResult | null;
  canSessions: boolean;
  sessionsKnownMissing: boolean;
  canEditProfiles: boolean;
  onManageLibrary: () => void;
  onSessionStart: (profile: string) => Promise<{ ok: boolean; message: string }>;
  onSessionEnd: () => Promise<{ ok: boolean; message: string }>;
  actionState: ActionState;
  onRequestAction: (a: ActionKind) => void;
  onReviewDrift: () => void;
  onConfirm: (a: ActionKind) => void;
  onCancel: () => void;
  onRecheck: () => Promise<void> | void;
}) {
  if (!doctorAvailable) return <DoctorUnreadable onRecheck={onRecheck} />;
  return (
    <div className="flex flex-col p-1.5">
      {chip ? (
        <StatusSummary
          chip={chip}
          nextAction={nextAction}
          advisories={advisories}
          onRunNextAction={onRequestAction}
        />
      ) : null}
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
          {row.reviewDrift ? (
            <button
              type="button"
              onClick={onReviewDrift}
              className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[10px] font-semibold text-foreground/85 transition-colors hover:border-warning/40 hover:bg-warning/10 hover:text-warning"
            >
              Review drift
            </button>
          ) : row.action ? (
            <button
              type="button"
              onClick={() => onRequestAction(row.action!)}
              className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[10px] font-semibold text-foreground/85 transition-colors hover:border-warning/40 hover:bg-warning/10 hover:text-warning"
            >
              {ACTION_META[row.action].label}
            </button>
          ) : null}
        </div>
      ))}
      {actionState.phase !== "idle" ? (
        <ActionConfirm state={actionState} onConfirm={onConfirm} onCancel={onCancel} />
      ) : null}
      <ToolsetsCard
        toolsets={toolsets}
        canSessions={canSessions}
        sessionsKnownMissing={sessionsKnownMissing}
        canEditProfiles={canEditProfiles}
        onManageLibrary={onManageLibrary}
        onStart={onSessionStart}
        onEnd={onSessionEnd}
      />
      <UndoAffordance
        loadInventory={loadRestoreInventory}
        onUndo={onUndo}
        canRestore={canRestore}
      />
    </div>
  );
}

/**
 * The status summary at the top of Overview: one chip derived from the doctor's
 * `state`, plus the single recommended next step. "Protected" (ready + guard +
 * machine policy) is the strongest posture — its title spells out that these
 * are cooperative host protections, not a sandbox.
 *
 * Exported for its own render test: this is the one place the panel makes a
 * readiness CLAIM, so what it draws for a given doctor payload is worth
 * asserting directly rather than only through the logic that feeds it.
 */
export function StatusSummary({
  chip,
  nextAction,
  advisories,
  onRunNextAction,
}: {
  chip: NonNullable<ReturnType<typeof deriveAgentstackStatusChip>>;
  nextAction: string | null;
  /** Null when the CLI doesn't advertise `doctor-advisories-v1`, or none exist. */
  advisories: number | null;
  /**
   * Run the recommendation, when it is one of the fixed actions this panel
   * already exposes. Omitted by callers that only display status. The command
   * text stays on screen either way — the button is an extra affordance, not a
   * replacement for saying what will run.
   */
  onRunNextAction?: ((action: ActionKind) => void) | undefined;
}) {
  const runnable = matchAgentstackNextAction(nextAction);
  return (
    <div className="mx-1 mb-1.5 flex flex-col gap-1.5 rounded-lg border border-border/50 bg-foreground/[0.02] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", LEVEL_DOT[chip.level])} aria-hidden />
        <span
          className="text-[12.5px] font-semibold text-foreground"
          title={
            chip.isProtected
              ? "Ready, with the host guard and a machine policy in force — cooperative protections, not a sandbox."
              : undefined
          }
        >
          {chip.label}
        </span>
        {advisories && advisories > 0 ? (
          // Deliberately beside the chip and deliberately muted: an advisory
          // must be visible without competing with readiness. "Ready · 2 notes"
          // is the honest reading — the CLI already excluded these from the
          // state, so styling them as a fault would re-introduce exactly the
          // permanent-orange problem the advisory tier removed.
          <span
            className="text-[11px] text-muted-foreground"
            title="Notes worth knowing that this project does not have to fix. Run `agentstack doctor` for the detail."
          >
            · {advisories} {advisories === 1 ? "note" : "notes"}
          </span>
        ) : null}
      </div>
      {nextAction ? (
        <div className="flex items-baseline gap-1.5">
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
            Next
          </span>
          <code className="min-w-0 wrap-break-word font-mono text-[11px] text-muted-foreground">
            {nextAction}
          </code>
          {runnable && onRunNextAction ? (
            <button
              type="button"
              onClick={() => onRunNextAction(runnable)}
              className="ml-auto inline-flex h-[22px] shrink-0 items-center rounded-md border border-accent/40 px-2 text-[11px] font-semibold text-accent hover:bg-accent/10"
            >
              {ACTION_META[runnable].label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type UndoLoad =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "empty" }
  | {
      phase: "ready";
      entry: { id: string; summary: string; time_unix: number };
    };

type UndoAct =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "running" }
  | { phase: "done"; ok: boolean; message: string };

/** Compact relative age from unix seconds. */
/**
 * The toolset picker (Slice 2): every declared profile as a "toolset" row —
 * readiness, what it selects, whether it is in use — plus the temporary
 * activation verbs. "Use temporarily" starts a session (the CLI's fail-closed
 * gate enforces trust/pins); "Stop using" reverts it. The active-session line
 * renders from the CLI's own store on every read, so a session an interrupted
 * panel left behind reappears here with its safe recovery action.
 */
function ToolsetsCard({
  toolsets,
  canSessions,
  sessionsKnownMissing,
  canEditProfiles,
  onManageLibrary,
  onStart,
  onEnd,
}: {
  toolsets: AgentstackToolsetsResult | null;
  canSessions: boolean;
  sessionsKnownMissing: boolean;
  canEditProfiles: boolean;
  onManageLibrary: () => void;
  onStart: (profile: string) => Promise<{ ok: boolean; message: string }>;
  onEnd: () => Promise<{ ok: boolean; message: string }>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ ok: boolean; message: string } | null>(null);

  const data = toolsets?.toolsets ?? null;
  const rows = useMemo(() => (data ? deriveToolsetRows(data.profiles, data.trust) : []), [data]);
  const session = data?.session ?? null;

  const start = useCallback(
    async (profile: string) => {
      setBusy(profile);
      setDone(null);
      const r = await onStart(profile);
      setBusy(null);
      setDone(r);
    },
    [onStart],
  );
  const end = useCallback(async () => {
    setBusy("__end__");
    setDone(null);
    const r = await onEnd();
    setBusy(null);
    setDone(r);
  }, [onEnd]);

  // Nothing to show: no declared profiles and nothing to recover. When the CLI
  // supports library edits we still render the header so "Browse library" (and
  // thus "New toolset") is reachable from a fresh project with zero toolsets.
  const empty = !data || (rows.length === 0 && !session);
  if (empty && !canEditProfiles) return null;

  return (
    <div className="mx-1 mt-1.5 border-t border-border/40 px-1.5 pt-2">
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Toolsets
        </span>
        {sessionsKnownMissing ? (
          <span className="text-[10px] text-muted-foreground/70">
            update agentstack to start one from here
          </span>
        ) : null}
        {canEditProfiles ? (
          <button
            type="button"
            onClick={onManageLibrary}
            className="ml-auto shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground transition-colors hover:bg-accent"
            title="Browse the skill & server library — add tools to a toolset or create a new one"
          >
            Browse library
          </button>
        ) : null}
      </div>

      {empty ? (
        <p className="px-2.5 pb-1.5 pt-0.5 text-[11px] leading-relaxed text-muted-foreground/70">
          No toolsets yet. Browse the library to add tools and create your first one.
        </p>
      ) : null}

      {session ? (
        <div className="mb-1 flex items-center gap-2 rounded-lg border border-success/25 bg-success/[0.07] px-2.5 py-2">
          <span className="size-[7px] shrink-0 rounded-full bg-success" />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            <span className="font-semibold">{session.profile}</span> in use ·{" "}
            {fmtAgo(session.started_unix)} — ends with your files back as they were
          </span>
          <Button
            disabled={busy !== null || !canSessions}
            onClick={() => void end()}
            size="xs"
            title={
              canSessions
                ? "Revert this temporary activation"
                : "This agentstack CLI predates session control from the panel — run `agentstack session end` in a terminal"
            }
            variant="outline"
          >
            {busy === "__end__" ? "Stopping…" : "Stop using"}
          </Button>
        </div>
      ) : null}

      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-2.5 rounded-lg px-2.5 py-[7px]">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              row.active ? "bg-success" : row.ready ? "bg-success/60" : "bg-warning",
            )}
          />
          <span className="min-w-0 shrink-0 max-w-[96px] truncate text-[12.5px] font-semibold text-foreground">
            {row.name}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={row.blockedBecause ?? row.summary}
          >
            {row.blockedBecause ?? row.summary}
          </span>
          {row.active ? (
            <span className="shrink-0 text-[10px] font-semibold text-success">in use</span>
          ) : row.ready && !session && canSessions ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void start(row.name)}
              className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {busy === row.name ? "Starting…" : "Use temporarily"}
            </button>
          ) : null}
        </div>
      ))}

      {done ? (
        <p
          className={cn(
            "px-2.5 pb-1 text-[11px]",
            done.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {done.message}
        </p>
      ) : null}
    </div>
  );
}

function undoAge(unixSeconds: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

type LibLoad =
  | { phase: "loading" }
  | { phase: "loaded"; index: NonNullable<AgentstackLibraryIndexResult["index"]> }
  | { phase: "error" };

/** The library browser's edit lifecycle: compose → preview (digest) → confirm →
 *  apply → result. Kept separate from the browse view so the same digest-confirm
 *  flow serves both "add to toolset" and "new toolset". */
type EditFlow =
  | { phase: "idle" }
  | { phase: "previewing"; edit: AgentstackProfileEdit; title: string }
  | {
      phase: "confirm";
      edit: AgentstackProfileEdit;
      title: string;
      digest: string;
      note: string | null;
      /** remove-from-library only: what leaves the machine-wide library, where
       *  it goes, and whether this project depends on it. Read straight from
       *  the CLI preview so the card warns with the CLI's own facts. */
      removal: NonNullable<AgentstackProfileEditPreview["removal"]> | null;
    }
  | { phase: "unsupported"; title: string }
  | { phase: "running"; edit: AgentstackProfileEdit; title: string }
  | { phase: "done"; ok: boolean; message: string; title: string };

type LibView =
  | { kind: "browse" }
  | { kind: "pick-target"; group: "skill" | "server"; name: string }
  | { kind: "new" };

/** A plain-language sentence for the change being confirmed. */
function describeEdit(edit: AgentstackProfileEdit): string {
  switch (edit.kind) {
    case "add-skill-to-profile":
      return `Add skill "${edit.name}" to toolset "${edit.profile}"`;
    case "add-server-to-profile":
      return `Add server "${edit.name}" to toolset "${edit.profile}"`;
    case "create-profile": {
      const parts: string[] = [];
      if (edit.skills.length > 0)
        parts.push(`${edit.skills.length} skill${edit.skills.length === 1 ? "" : "s"}`);
      if (edit.servers.length > 0)
        parts.push(`${edit.servers.length} server${edit.servers.length === 1 ? "" : "s"}`);
      return `New toolset "${edit.name}"${parts.length > 0 ? ` with ${parts.join(" and ")}` : ""}`;
    }
    case "remove-from-library":
      // "from your library" — not "from this project". The scope is the whole
      // point of this confirmation.
      return `Remove ${edit.group} "${edit.name}" from your library`;
  }
}

/**
 * Recognize the fail-closed "an unresolved ${REF} blocked the render" outcome in
 * the CLI's result line, and pull the reference name when it's there. This is a
 * feature, not an error: the manifest kept the `${REF}` (no value leaked) and
 * the render is blocked until the secret is set — so it gets its own
 * what/why/next-step card instead of a red failure banner.
 */
function matchSecretBlock(message: string): { ref: string | null } | null {
  if (!/unresolved secret|\$\{|not written/i.test(message)) return null;
  const ref =
    /\$\{([A-Za-z0-9_]+)\}/.exec(message)?.[1] ??
    /secret set\s+([A-Za-z0-9_]+)/i.exec(message)?.[1] ??
    /\b([A-Z][A-Z0-9_]{2,})\b/.exec(message)?.[1] ??
    null;
  return { ref };
}

/**
 * The library browser (Lane B4): reads `library-index` and lets the user add a
 * skill/server to a toolset, or create a new toolset seeded with library/inline
 * capabilities. Both mutations go through the digest-confirm flow — a preview
 * returns the CLI's consent digest over the intended change + manifest bytes,
 * and the apply presents it back (`--yes --consented`), so "the user reviewed
 * this exact change" is CLI-enforced. Activation stays fail-closed: an
 * unresolved `${REF}` blocks the render and surfaces its own next-step card.
 * The panel never composes a command line — it names an edit; the server maps it
 * to fixed argv.
 */
function LibraryPanel({
  loadIndex,
  preview,
  apply,
  canRemove,
  onClose,
}: {
  loadIndex: () => Promise<AgentstackLibraryIndexResult | null>;
  preview: (edit: AgentstackProfileEdit) => Promise<AgentstackProfileEditPreviewResult | null>;
  apply: (
    edit: AgentstackProfileEdit,
    consentedDigest: string,
  ) => Promise<{ ok: boolean; message: string }>;
  /** Whether this CLI advertises `library-remove-v1`. */
  canRemove: boolean;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<LibLoad>({ phase: "loading" });
  const [view, setView] = useState<LibView>({ kind: "browse" });
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<EditFlow>({ phase: "idle" });
  // New-toolset draft (only used in the "new" view).
  const [draftName, setDraftName] = useState("");
  const [draftSkills, setDraftSkills] = useState<ReadonlyArray<string>>([]);
  const [draftServers, setDraftServers] = useState<ReadonlyArray<string>>([]);

  const reload = useCallback(async () => {
    const r = await loadIndex();
    setLoad(r?.index ? { phase: "loaded", index: r.index } : { phase: "error" });
  }, [loadIndex]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const index = load.phase === "loaded" ? load.index : null;
  const profiles = index?.profiles ?? [];

  // Compose → preview → confirm. A preview without a digest (older CLI) can't be
  // applied, so it lands in `unsupported` rather than offering a doomed confirm.
  const beginEdit = useCallback(
    async (edit: AgentstackProfileEdit) => {
      const title = describeEdit(edit);
      setFlow({ phase: "previewing", edit, title });
      const result = await preview(edit);
      const digest = result?.preview?.consent_digest ?? null;
      if (digest) {
        setFlow({
          phase: "confirm",
          edit,
          title,
          digest,
          note: result?.preview?.note ?? null,
          removal: result?.preview?.removal ?? null,
        });
      } else {
        setFlow({ phase: "unsupported", title });
      }
    },
    [preview],
  );

  const confirmEdit = useCallback(async () => {
    if (flow.phase !== "confirm") return;
    const { edit, title, digest } = flow;
    setFlow({ phase: "running", edit, title });
    const r = await apply(edit, digest);
    setFlow({ phase: "done", ok: r.ok, message: r.message, title });
    if (r.ok) {
      // A successful add/create changed the manifest — refresh in_manifest flags
      // and the toolset list. (A ${REF}-blocked apply also wrote the manifest, so
      // reload there too to reflect the partial state honestly.)
      await reload();
    } else if (matchSecretBlock(r.message)) {
      await reload();
    }
  }, [flow, apply, reload]);

  // Reset the browse view + draft after a flow finishes.
  const backToBrowse = useCallback(() => {
    setFlow({ phase: "idle" });
    setView({ kind: "browse" });
    setDraftName("");
    setDraftSkills([]);
    setDraftServers([]);
  }, []);

  const toggle = (list: ReadonlyArray<string>, name: string): ReadonlyArray<string> =>
    list.includes(name) ? list.filter((n) => n !== name) : [...list, name];

  return (
    <div className="max-h-[460px] overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border/60 px-3.5 py-2">
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          ← Back
        </button>
        <span className="text-xs font-semibold text-foreground">Library</span>
      </div>

      {/* The edit flow takes over the body while active. */}
      {flow.phase !== "idle" ? (
        <EditFlowCard flow={flow} onConfirm={confirmEdit} onBack={backToBrowse} />
      ) : load.phase === "loading" ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">Loading library…</p>
      ) : load.phase === "error" || index === null ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
          Couldn't read the library — <code className="font-mono">agentstack library-index</code>{" "}
          didn't return a catalog for this project.
        </p>
      ) : view.kind === "pick-target" ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Add the {view.group} <span className="font-semibold text-foreground">{view.name}</span>{" "}
            to which toolset?
          </p>
          {profiles.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              No toolsets yet — create one first, then add tools to it.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {profiles.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() =>
                    void beginEdit(
                      view.group === "skill"
                        ? { kind: "add-skill-to-profile", profile: p, name: view.name }
                        : { kind: "add-server-to-profile", profile: p, name: view.name },
                    )
                  }
                  className="flex items-center gap-2 rounded-lg border border-border/50 px-2.5 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:border-border hover:bg-accent"
                >
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                  {p}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setView({ kind: "browse" })}
            className="self-start text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : view.kind === "new" ? (
        <div className="flex flex-col gap-3 px-4 py-3 text-xs">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Name a new toolset and pick the tools it bundles. You can activate it afterward from the
            Toolsets list.
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
              Toolset name
            </span>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="e.g. web"
              spellCheck={false}
              className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-border"
            />
          </label>

          <LibrarySelectGroup
            title="Skills"
            items={index.skills.map((s) => ({ name: s.name, hint: s.origin }))}
            selected={draftSkills}
            onToggle={(name) => setDraftSkills((l) => toggle(l, name))}
          />
          <LibrarySelectGroup
            title="Servers"
            items={index.servers.map((s) => ({ name: s.name, hint: s.origin }))}
            selected={draftServers}
            onToggle={(name) => setDraftServers((l) => toggle(l, name))}
          />

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={
                !PROFILE_NAME_INPUT_RE.test(draftName) ||
                (draftSkills.length === 0 && draftServers.length === 0)
              }
              onClick={() =>
                void beginEdit({
                  kind: "create-profile",
                  name: draftName,
                  skills: [...draftSkills],
                  servers: [...draftServers],
                })
              }
              className="inline-flex h-8 items-center rounded-lg border border-success/40 bg-success/10 px-3.5 text-xs font-semibold text-success disabled:opacity-50"
            >
              Create toolset
            </button>
            <button
              type="button"
              onClick={() => setView({ kind: "browse" })}
              className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          {draftName.length > 0 && !PROFILE_NAME_INPUT_RE.test(draftName) ? (
            <p className="text-[10.5px] text-warning">
              Use letters, numbers, dot, dash or underscore (no spaces).
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
              Tools available to bundle into a toolset. Adding one enrolls it and re-locks the
              toolset.
            </p>
            <button
              type="button"
              onClick={() => setView({ kind: "new" })}
              className="shrink-0 rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success transition-colors hover:bg-success/20"
            >
              + New toolset
            </button>
          </div>

          {/* A library of any real size is unscrollable in a 360px column. */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter skills and servers…"
            aria-label="Filter the library"
            className="h-7 w-full rounded-lg border border-border/60 bg-background px-2.5 text-[11px] text-foreground placeholder:text-muted-foreground/60"
          />

          <LibraryBrowseGroup
            title="Skills"
            emptyLabel={
              query.trim().length > 0
                ? "No skills match that filter."
                : "No skills in the library yet."
            }
            items={filterAgentstackLibraryItems(
              index.skills.map((s) => ({
                name: s.name,
                origin: s.origin,
                detail: s.description,
                inManifest: s.in_manifest,
              })),
              query,
            )}
            hasToolsets={profiles.length > 0}
            onAdd={(name) => setView({ kind: "pick-target", group: "skill", name })}
            onRemove={
              canRemove
                ? (name) => void beginEdit({ kind: "remove-from-library", group: "skill", name })
                : null
            }
          />
          <LibraryBrowseGroup
            title="Servers"
            emptyLabel={
              query.trim().length > 0
                ? "No servers match that filter."
                : "No servers in the library yet."
            }
            items={filterAgentstackLibraryItems(
              index.servers.map((s) => ({
                name: s.name,
                origin: s.origin,
                detail: s.provenance ?? null,
                inManifest: s.in_manifest,
              })),
              query,
            )}
            hasToolsets={profiles.length > 0}
            onAdd={(name) => setView({ kind: "pick-target", group: "server", name })}
            onRemove={
              canRemove
                ? (name) => void beginEdit({ kind: "remove-from-library", group: "server", name })
                : null
            }
          />
        </div>
      )}
    </div>
  );
}

/** Toolset-name input shape, mirrored from the server's PROFILE-name guard so
 *  the create button disables before a doomed round-trip. */
const PROFILE_NAME_INPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** One browsable group (skills or servers) in the library browser. */
function LibraryBrowseGroup({
  title,
  emptyLabel,
  items,
  hasToolsets,
  onAdd,
  onRemove,
}: {
  title: string;
  emptyLabel: string;
  items: ReadonlyArray<{
    name: string;
    origin: string;
    detail: string | null;
    inManifest: boolean;
  }>;
  hasToolsets: boolean;
  onAdd: (name: string) => void;
  /** Remove from the machine-wide central library. Offered only on
   *  `library`-origin rows — a `manifest`-origin row is this project's own
   *  inline capability, which the library has no copy of to remove. `null` when
   *  the CLI doesn't advertise `library-remove-v1`. */
  onRemove: ((name: string) => void) | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </p>
      {items.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/70">{emptyLabel}</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((it) => (
            <div
              key={`${it.origin}:${it.name}`}
              className="group flex items-center gap-2 rounded-lg px-1.5 py-[6px] hover:bg-foreground/[0.03]"
            >
              <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-semibold text-foreground">
                  {it.name}
                  {it.inManifest ? (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/60">
                      in project
                    </span>
                  ) : null}
                </span>
                {it.detail ? (
                  <span
                    className="line-clamp-2 text-[10.5px] leading-snug text-muted-foreground"
                    title={it.detail}
                  >
                    {it.detail}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={!hasToolsets}
                onClick={() => onAdd(it.name)}
                title={
                  hasToolsets
                    ? "Add this to a toolset"
                    : "Create a toolset first, then add tools to it"
                }
                className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                Add
              </button>
              {onRemove !== null && it.origin === "library" ? (
                // `Add` enrolls this capability in a toolset for THIS project;
                // `Remove` deletes it from the machine-wide library, for every
                // project. Two very different blast radii, so they no longer
                // sit side by side as equals: the destructive one appears on
                // row hover or keyboard focus and carries destructive colour
                // the moment it is visible. (The click still opens the
                // digest-bound confirm — this is about not offering a
                // machine-wide delete as a permanent neighbour of a
                // project-scoped add.)
                <button
                  type="button"
                  onClick={() => onRemove(it.name)}
                  title="Remove from your library (all projects) — recoverable"
                  aria-label={`Remove ${it.name} from your library`}
                  className="shrink-0 rounded-md border border-transparent px-1.5 py-0.5 text-[10px] font-semibold text-destructive/80 opacity-0 transition-all hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One multi-select group for the new-toolset form. */
function LibrarySelectGroup({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: ReadonlyArray<{ name: string; hint: string }>;
  selected: ReadonlyArray<string>;
  onToggle: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </p>
      {items.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/70">none available</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((it) => {
            const on = selected.includes(it.name);
            return (
              <button
                key={`${it.hint}:${it.name}`}
                type="button"
                onClick={() => onToggle(it.name)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                  on
                    ? "border-success/40 bg-success/[0.07]"
                    : "border-border/50 hover:border-border",
                )}
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    on ? "bg-success" : "bg-muted-foreground/30",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                  {it.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground/60">{it.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The digest-confirm card for one library edit — the load-bearing consent step.
 * A preview without a digest disables the confirm (`unsupported`); the applied
 * result shows a plain success line, or — when an unresolved `${REF}` blocked
 * the render — a what/why/next-step card naming the exact `agentstack secret
 * set` command, never a bare red failure.
 */
function EditFlowCard({
  flow,
  onConfirm,
  onBack,
}: {
  flow: Exclude<EditFlow, { phase: "idle" }>;
  onConfirm: () => void;
  onBack: () => void;
}) {
  if (flow.phase === "previewing") {
    return (
      <div className="px-4 py-4">
        <p className="text-xs text-muted-foreground">Preparing "{flow.title}"…</p>
      </div>
    );
  }
  if (flow.phase === "unsupported") {
    return (
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[12.5px] font-semibold text-foreground">{flow.title}</p>
        <p className="text-[11px] leading-relaxed text-warning">
          This agentstack CLI's preview has no digest to confirm against, so this change can't be
          applied from here. Update agentstack, or make the change in a terminal.
        </p>
        <button
          type="button"
          onClick={onBack}
          className="self-start text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          ← Back to library
        </button>
      </div>
    );
  }
  if (flow.phase === "done") {
    const secretBlock = flow.ok ? null : matchSecretBlock(flow.message);
    return (
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[12.5px] font-semibold text-foreground">{flow.title}</p>
        {secretBlock ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-[11px] leading-relaxed">
            <span className="font-semibold text-warning">Set a secret to finish</span>
            <span className="text-muted-foreground">
              The toolset was written, but a value it needs isn't set yet, so AgentStack kept the{" "}
              <code className="font-mono">
                {secretBlock.ref ? `\${${secretBlock.ref}}` : "${…}"}
              </code>{" "}
              placeholder and didn't render the config — nothing leaked.
            </span>
            <span className="text-muted-foreground">
              Set it, then activate the toolset:
              <code className="mt-1 block break-all font-mono text-foreground">
                agentstack secret set {secretBlock.ref ?? "<REF>"}
              </code>
            </span>
          </div>
        ) : (
          <div
            className={cn(
              "rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
              flow.ok
                ? "border-success/30 bg-success/[0.06]"
                : "border-destructive/30 bg-destructive/[0.06]",
            )}
          >
            <span className={cn("font-semibold", flow.ok ? "text-success" : "text-destructive")}>
              {flow.ok ? "Done" : "Couldn't apply"}
            </span>
            {" — "}
            <span className="break-words font-mono text-muted-foreground">{flow.message}</span>
          </div>
        )}
        <button
          type="button"
          onClick={onBack}
          className="self-start text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          ← Back to library
        </button>
      </div>
    );
  }
  // confirm | running
  const running = flow.phase === "running";
  const removing = flow.edit.kind === "remove-from-library";
  const removal = flow.phase === "confirm" ? flow.removal : null;
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-[12.5px] font-semibold text-foreground">{flow.title}</p>
      {removing ? (
        <RemovalConfirmBody removal={removal} />
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Applying re-locks and re-renders the toolset. An unresolved{" "}
          <code className="font-mono">${"{REF}"}</code> secret blocks the render (set it, then
          re-apply) — nothing is written until you confirm.
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={running}
          onClick={onConfirm}
          className={cn(
            "inline-flex h-8 items-center rounded-lg border px-3.5 text-xs font-semibold disabled:opacity-60",
            removing
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-success/40 bg-success/10 text-success",
          )}
        >
          {running ? (removing ? "Removing…" : "Applying…") : removing ? "Remove" : "Confirm"}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={onBack}
          className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
      {flow.phase === "confirm" ? (
        <details className="text-[10.5px] text-muted-foreground/60">
          <summary className="cursor-pointer select-none">Details</summary>
          <code className="mt-1 block break-all font-mono">
            change {shortDigest(flow.digest) ?? flow.digest}
          </code>
        </details>
      ) : null}
    </div>
  );
}

/**
 * A shell command rendered so it stays both readable and copyable in a narrow
 * card: it wraps at spaces, and never inside a token.
 *
 * Plain wrapping is not enough — CSS takes a break opportunity after a hyphen,
 * so `--write` splits into `-` + `-write` and reads as a typo; `nowrap` with a
 * scrollbar hides the tail of the command instead. Each token therefore gets
 * its own `nowrap` span, with the separating spaces left as text between them
 * so they remain the only break opportunities — and a copy still yields the
 * exact command.
 */
function CommandLine({ text }: { text: string }) {
  // Key each token by where it starts in the command: a real property of the
  // token (two identical flags at different positions stay distinct), so the
  // list needs no index key.
  const tokens = useMemo(() => {
    let offset = 0;
    return text.split(" ").map((token) => {
      const at = offset;
      offset += token.length + 1;
      return { key: `${at}:${token}`, token, isFirst: at === 0 };
    });
  }, [text]);
  return (
    <code className="mt-1 block font-mono text-[10.5px] text-foreground">
      {tokens.map(({ key, token, isFirst }) => (
        <Fragment key={key}>
          {isFirst ? null : " "}
          <span className="whitespace-nowrap">{token}</span>
        </Fragment>
      ))}
    </code>
  );
}

/**
 * The body of the removal confirmation: scope first (this is machine-wide, not
 * project-local), then the in-use warning when this project actually references
 * the name, then the recovery line. Removal edits no manifest and re-renders
 * nothing, so a project that depends on the name keeps working until its next
 * lock/activate — saying that plainly is the difference between an informed
 * click and a surprise.
 */
function RemovalConfirmBody({
  removal,
}: {
  removal: NonNullable<AgentstackProfileEditPreview["removal"]> | null;
}) {
  const usedHere = removal?.used_by_this_project === true;
  const profiles = removal?.profiles ?? [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This removes it from your library on this machine — every project that uses it by name is
        affected. Nothing in this project's files changes right now.
      </p>
      {usedHere ? (
        <div className="rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[11px] leading-relaxed">
          <span className="font-semibold text-warning">This project uses it</span>
          <span className="text-muted-foreground">
            {profiles.length > 0
              ? ` — toolset${profiles.length === 1 ? "" : "s"} ${profiles.join(", ")}. `
              : " — it's referenced here. "}
            {removal?.defined_inline_here
              ? "This project defines its own copy, so it keeps working."
              : "Activating that toolset again will fail until you re-add or restore it."}
          </span>
        </div>
      ) : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        It moves to the library trash, so you can put it back:
        <CommandLine
          text={removal?.restore_command ?? "agentstack lib trash --restore <id> --write"}
        />
      </p>
    </div>
  );
}

/**
 * "Undo last change" — backed by the machine-global restore ledger. On demand
 * it loads the inventory and picks the newest entry whose files live under THIS
 * workspace and that hasn't been undone yet (never a blind `--last`), shows its
 * summary and age, and undoes that specific entry by id behind a confirm step.
 * Disabled with an upgrade hint when the CLI doesn't advertise the contract.
 */
function UndoAffordance({
  loadInventory,
  onUndo,
  canRestore,
}: {
  loadInventory: () => Promise<AgentstackRestoreInventoryResult | null>;
  onUndo: (restoreId: string) => Promise<{ ok: boolean; message: string }>;
  canRestore: boolean;
}) {
  const [load, setLoad] = useState<UndoLoad>({ phase: "idle" });
  const [act, setAct] = useState<UndoAct>({ phase: "idle" });

  const reveal = useCallback(async () => {
    setLoad({ phase: "loading" });
    setAct({ phase: "idle" });
    const result = await loadInventory();
    const entry = result?.inventory ? selectAgentstackUndoEntry(result.inventory.entries) : null;
    setLoad(
      entry
        ? {
            phase: "ready",
            entry: { id: entry.id, summary: entry.summary, time_unix: entry.time_unix },
          }
        : { phase: "empty" },
    );
  }, [loadInventory]);

  const run = useCallback(async () => {
    if (load.phase !== "ready") return;
    setAct({ phase: "running" });
    const r = await onUndo(load.entry.id);
    setAct({ phase: "done", ok: r.ok, message: r.message });
    // Re-pull so a repeat click reflects the entry now being undone.
    await reveal();
  }, [load, onUndo, reveal]);

  if (!canRestore) {
    return (
      <div className="mx-1 mt-1.5 border-t border-border/40 px-1.5 pt-2">
        <span className="text-[11px] text-muted-foreground/70" title="Update the agentstack CLI">
          Undo isn't available on this agentstack CLI — update it to revert managed changes.
        </span>
      </div>
    );
  }

  return (
    <div className="mx-1 mt-1.5 flex flex-col gap-1.5 border-t border-border/40 px-1.5 pt-2">
      {load.phase === "idle" ? (
        <button
          type="button"
          onClick={() => void reveal()}
          className="inline-flex h-7 items-center self-start rounded-lg border border-border/60 px-2.5 text-[11px] font-semibold text-foreground/90 transition-colors hover:border-border hover:bg-foreground/[0.04] hover:text-foreground"
        >
          Undo last change…
        </button>
      ) : load.phase === "loading" ? (
        <span className="text-[11px] text-muted-foreground">Checking recent changes…</span>
      ) : load.phase === "empty" ? (
        <span className="text-[11px] text-muted-foreground">
          Nothing to undo — no recorded change touches this project.
        </span>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Undo <span className="font-semibold text-foreground">{load.entry.summary}</span>{" "}
            <span className="text-muted-foreground/70">· {undoAge(load.entry.time_unix)}</span>
          </p>
          {act.phase === "confirm" || act.phase === "running" ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={act.phase === "running"}
                onClick={() => void run()}
                className="inline-flex h-6 items-center rounded-md border border-warning/40 bg-warning/15 px-2.5 text-[11px] font-semibold text-warning disabled:opacity-60"
              >
                {act.phase === "running" ? "Undoing…" : "Undo this change"}
              </button>
              <button
                type="button"
                disabled={act.phase === "running"}
                onClick={() => setAct({ phase: "idle" })}
                className="inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          ) : act.phase === "done" ? (
            <div
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed",
                act.ok
                  ? "border-success/30 bg-success/[0.06]"
                  : "border-destructive/30 bg-destructive/[0.06]",
              )}
            >
              <span className={cn("font-semibold", act.ok ? "text-success" : "text-destructive")}>
                {act.ok ? "Undone" : "Couldn't undo"}
              </span>
              {" — "}
              <span className="break-words font-mono text-muted-foreground">{act.message}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAct({ phase: "confirm" })}
              className="self-start text-[11px] font-semibold text-warning underline-offset-2 hover:underline"
            >
              Undo this change
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The capability-negotiation body: shown when a read reports a `schema_version`
 * higher than this t3code build supports. Names both versions so the user knows
 * which side to update; actions are unavailable in this state.
 */
function UpdateNeeded({
  incompatible,
  cliVersion,
}: {
  incompatible: { cliSchema: number; supported: number };
  cliVersion: string | null;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-xs leading-relaxed text-muted-foreground">
      <p className="text-[12.5px] font-semibold text-foreground">Update t3code to continue</p>
      <p>
        This project's <code className="font-mono">agentstack</code> CLI
        {cliVersion ? (
          <>
            {" "}
            (<span className="font-mono">{cliVersion.replace(/^agentstack\s*/, "v")}</span>)
          </>
        ) : null}{" "}
        speaks a newer data format (schema {incompatible.cliSchema}) than this t3code build
        understands (schema {incompatible.supported}). Update t3code to read this AgentStack CLI —
        until then, the panel's actions are disabled to avoid acting on data it can't fully read.
      </p>
    </div>
  );
}

type SetupLoad =
  | { phase: "loading" }
  | { phase: "loaded"; plan: AgentstackSetupPlan; home?: string | undefined }
  | { phase: "error" };

type SetupAct =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "running" }
  | { phase: "done"; ok: boolean; message: string };

/**
 * The secret-store choices offered when the plan lifts token values out of
 * imported configs. `.env` is the default (product principle: the simplest
 * local path), with the plain-language trade-off stated. The plan_digest binds
 * the choice, so switching re-reads the plan for a matching digest.
 */
const SECRETS_CHOICES: ReadonlyArray<{
  value: AgentstackSecretsDestination;
  label: string;
  detail: string;
}> = [
  {
    value: "env",
    label: ".env file",
    detail:
      "Store token values in a .env file in this project (gitignored). Simplest for local work; the file holds them in plain text.",
  },
  {
    value: "keychain",
    label: "System keychain",
    detail:
      "Store token values in your operating system's keychain, kept out of the project folder.",
  },
  {
    value: "skip",
    label: "Don't store yet",
    detail:
      "Write only ${REF} placeholders now — provide each value later with agentstack secret set.",
  },
];

/**
 * The first-run setup card, shown when the project has no manifest yet. It
 * renders `init --plan` in plain language — the tools found, what would be
 * imported, the file AgentStack will manage, and the secret names the user
 * still provides — behind one "Set up this project" button. No trust/policy/
 * digest vocabulary on the card itself (the digest lives in a Details
 * disclosure); it presents the plan_digest back on apply so the CLI writes
 * nothing if detection changed. Disabled with an upgrade note when the CLI's
 * plan carries no digest.
 */
function SetupPanel({
  loadPlan,
  onApply,
  canApply,
}: {
  loadPlan: (
    secretsDestination: AgentstackSecretsDestination,
  ) => Promise<AgentstackSetupPlanResult | null>;
  onApply: (
    planDigest: string,
    secretsDestination: AgentstackSecretsDestination,
  ) => Promise<{ ok: boolean; message: string }>;
  canApply: boolean;
}) {
  // `.env` by default (product principle); the picker below appears only when
  // the plan actually lifts secrets, so when nothing is lifted this choice is
  // applied silently and never shown.
  const [secretsChoice, setSecretsChoice] = useState<AgentstackSecretsDestination>("env");
  const [load, setLoad] = useState<SetupLoad>({ phase: "loading" });
  // A choice change re-reads the plan (for a digest bound to the new store)
  // while keeping the prior plan on screen; the first read shows `loading`.
  const [reloading, setReloading] = useState(false);
  const [act, setAct] = useState<SetupAct>({ phase: "idle" });

  useEffect(() => {
    let alive = true;
    setReloading(true);
    void loadPlan(secretsChoice).then((result) => {
      if (!alive) return;
      setLoad(
        result?.plan
          ? { phase: "loaded", plan: result.plan, home: result.home }
          : { phase: "error" },
      );
      setReloading(false);
    });
    return () => {
      alive = false;
    };
  }, [loadPlan, secretsChoice]);

  // Switching the store invalidates the reviewed digest and any prior result,
  // so reset the confirm/done state; the effect above re-reads for the new one.
  const pickSecrets = (choice: AgentstackSecretsDestination) => {
    if (choice === secretsChoice) return;
    setAct({ phase: "idle" });
    setSecretsChoice(choice);
  };

  const plan = load.phase === "loaded" ? load.plan : null;
  // Display context for the path lists below: inside the project we show a
  // relative path, elsewhere under home we show `~/…`. Never applied to the
  // payload itself — the plan digest is taken over what the CLI sent.
  const paths = {
    root: plan?.path,
    home: load.phase === "loaded" ? load.home : undefined,
  };
  const planDigest = plan?.plan_digest ?? null;
  // The genuine "can't set up from here" cases — no apply feature, or a plan
  // with no digest to bind — as opposed to a transient re-read. Drives the
  // explanatory warning so a brief re-read never flashes a misleading reason.
  const setupUnsupported = !canApply || planDigest === null;
  // Setup can proceed only when supported AND not mid-re-read, when the
  // on-screen digest may not yet match the selected store.
  const canSetUp = !setupUnsupported && !reloading;

  const run = async () => {
    if (planDigest === null) return;
    setAct({ phase: "running" });
    const r = await onApply(planDigest, secretsChoice);
    setAct({ phase: "done", ok: r.ok, message: r.message });
  };

  if (load.phase === "loading") {
    return <p className="px-4 py-4 text-xs text-muted-foreground">Preparing setup…</p>;
  }
  if (plan === null) {
    return (
      <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        Couldn't prepare a setup plan — <code className="font-mono">agentstack init --plan</code>{" "}
        didn't return one for this project.
      </p>
    );
  }

  const settingsFrom = plan.settings_from ?? [];
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-xs">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Set up AgentStack for this project — it unifies the tools you already have. Here's what it
        will do:
      </p>

      <SetupGroup title="Coding tools found">
        {plan.detected.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">none detected</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-[11px] leading-relaxed">
            {plan.detected.map((d) => (
              <li key={d.id}>
                <span className="font-semibold text-foreground">{d.display}</span>{" "}
                {(d.configs?.length ?? 0) > 0 ? (
                  <code className="wrap-break-word font-mono text-muted-foreground/90">
                    {d.configs?.map((c) => shortenAgentstackPath(c, paths)).join(" · ")}
                  </code>
                ) : (
                  <span className="text-muted-foreground/70">
                    {d.bin_on_path === true
                      ? "installed — no config files found"
                      : "no config files found"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </SetupGroup>

      <SetupGroup title="What will be imported">
        {plan.servers.length === 0 && settingsFrom.length === 0 && plan.conflicts.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">nothing to import</span>
        ) : (
          <ul className="flex flex-col gap-1 text-[11px] leading-relaxed">
            {plan.servers.map((s) => (
              <li key={s.name}>
                <span className="font-semibold text-foreground">{s.name}</span>{" "}
                <span className="text-muted-foreground">
                  {s.kind === "stdio" ? "runs" : "contacts"}
                </span>{" "}
                <code className="wrap-break-word font-mono text-muted-foreground/90">
                  {shortenAgentstackPathsIn(s.target, paths)}
                </code>
              </li>
            ))}
            {settingsFrom.length > 0 ? (
              <li className="text-muted-foreground">Settings from {settingsFrom.join(", ")}</li>
            ) : null}
            {plan.conflicts.map((c) => (
              <li key={c.name} className="text-warning">
                {c.name} is defined by {c.other_definitions + 1} tools — one will be used
              </li>
            ))}
          </ul>
        )}
      </SetupGroup>

      <SetupGroup title="Files AgentStack will manage">
        <ul className="flex flex-col gap-0.5 text-[11px] leading-relaxed">
          <li>
            <code className="wrap-break-word font-mono text-muted-foreground/90">
              {shortenAgentstackPath(plan.manifest_path, paths)}
            </code>{" "}
            <span className="text-muted-foreground/70">— the manifest, written by setup</span>
          </li>
          {(plan.destinations ?? []).map((d) => (
            <li key={`${d.id}:${d.path}`}>
              <code className="wrap-break-word font-mono text-muted-foreground/90">
                {shortenAgentstackPath(d.path, paths)}
              </code>{" "}
              <span className="text-muted-foreground/70">
                — {d.display} · {d.writes.join(" + ")} (
                {d.scope === "project" ? "this project" : "machine-wide"})
              </span>
            </li>
          ))}
        </ul>
        {(plan.destinations?.length ?? 0) > 0 ? (
          <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
            Native files are written when you apply the setup to your tools, not by setup itself.
          </p>
        ) : null}
      </SetupGroup>

      {plan.secrets.length > 0 ? (
        <SetupGroup title="Values you'll still provide">
          <ul className="flex flex-col gap-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {plan.secrets.map((s) => (
              <li key={s.reference}>
                <code className="font-mono text-foreground">{s.reference}</code>{" "}
                <span className="text-muted-foreground/70">— {s.origin}</span>
              </li>
            ))}
          </ul>
        </SetupGroup>
      ) : null}

      {/* Where those lifted values are stored. Shown only when the plan lifts
          secrets — no decision to surface otherwise (the default applies
          silently). Changing it re-reads the plan for a matching digest. */}
      {plan.secrets.length > 0 ? (
        <SetupGroup title="Where token values are stored">
          <div className="flex flex-col gap-1">
            {SECRETS_CHOICES.map((c) => {
              const selected = secretsChoice === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  disabled={reloading || act.phase === "running"}
                  onClick={() => pickSecrets(c.value)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-60",
                    selected
                      ? "border-success/40 bg-success/[0.07]"
                      : "border-border/50 hover:border-border",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        selected ? "bg-success" : "bg-muted-foreground/30",
                      )}
                    />
                    {c.label}
                  </span>
                  <span className="pl-3.5 text-[10.5px] leading-relaxed text-muted-foreground">
                    {c.detail}
                  </span>
                </button>
              );
            })}
          </div>
          {reloading ? (
            <p className="text-[10.5px] text-muted-foreground/60">Updating the plan…</p>
          ) : null}
        </SetupGroup>
      ) : null}

      {setupUnsupported ? (
        <p className="text-[11px] leading-relaxed text-warning">
          {canApply
            ? "This agentstack CLI's plan has no digest to confirm against, so setup from here is disabled. Update agentstack, or run agentstack init in a terminal."
            : "This agentstack CLI doesn't support one-click setup. Update agentstack, or run agentstack init in a terminal."}
        </p>
      ) : null}

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
            {act.ok ? "Set up" : "Couldn't set up"}
          </span>
          {" — "}
          <span className="break-words font-mono text-muted-foreground">{act.message}</span>
        </div>
      ) : act.phase === "confirm" || act.phase === "running" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={act.phase === "running"}
            onClick={() => void run()}
            className="inline-flex h-7 items-center rounded-lg border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success disabled:opacity-60"
          >
            {act.phase === "running" ? "Setting up…" : "Confirm setup"}
          </button>
          <button
            type="button"
            disabled={act.phase === "running"}
            onClick={() => setAct({ phase: "idle" })}
            className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!canSetUp}
          onClick={() => setAct({ phase: "confirm" })}
          className="inline-flex h-8 items-center self-start rounded-lg border border-success/40 bg-success/10 px-3.5 text-xs font-semibold text-success disabled:opacity-60"
        >
          Set up this project
        </button>
      )}

      {planDigest ? (
        <details className="text-[10.5px] text-muted-foreground/60">
          <summary className="cursor-pointer select-none">Details</summary>
          <code className="mt-1 block break-all font-mono">
            plan {shortDigest(planDigest) ?? planDigest}
          </code>
        </details>
      ) : null}
    </div>
  );
}

function SetupGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </p>
      {children}
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
  const action =
    state.phase === "confirm" || state.phase === "running" ? state.action : "guard-install";
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

function WorkflowPanel({
  data,
  incompatible,
  observeKnownMissing,
  cliVersion,
  onOpenRun,
}: {
  data: AgentstackWorkflowData | null;
  /** Non-null when the workflow read's schema outruns this build — takes over
   *  the section with the same upgrade notice other reads use. */
  incompatible: AgentstackIncompatible | null;
  /** True only when the CLI positively advertises its contracts but not
   *  workflow observation. False for legacy binaries (empty features), so the
   *  monitor renders exactly as before. */
  observeKnownMissing: boolean;
  cliVersion: string | null;
  onOpenRun: (run: AgentstackWorkflowRunSummary) => void;
}) {
  if (data === null) {
    return <p className="px-4 py-4 text-xs text-muted-foreground">Checking workflows…</p>;
  }
  // A workflow read whose schema outruns this build: don't render a half-read
  // monitor — show the same upgrade notice the panel uses for other reads.
  if (incompatible) {
    return <UpdateNeeded incompatible={incompatible} cliVersion={cliVersion} />;
  }
  // The live run renders as the full monitor; the history below excludes it
  // so a run never appears twice.
  const history = (data.runs ?? []).filter((r) => r.outcome !== "running");
  // The CLI advertises its contracts but not workflow observation: what the
  // monitor shows below may be partial. Legacy binaries (empty features) never
  // hit this, so the section is byte-for-byte unchanged for them.
  const observeNote = observeKnownMissing ? (
    <p className="border-b border-border/60 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
      This project's <code className="font-mono">agentstack</code> CLI doesn't report structured
      workflow observation. Update it for the full monitor; run details below may be limited.
    </p>
  ) : null;
  if (data.activeRun && data.activeRun.outcome === "running") {
    return (
      <div className="flex flex-col">
        {observeNote}
        <WorkflowMonitor run={data.activeRun} />
        <WorkflowRunHistory runs={history} onOpenRun={onOpenRun} />
      </div>
    );
  }
  if (data.workflows.length === 0) {
    return (
      <div className="flex flex-col">
        {observeNote}
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
          No workflows declared. A <code className="font-mono">[workflows.*]</code> entry in the
          manifest defines a governed, pinned workflow — each step a locked run.
        </p>
        <WorkflowRunHistory runs={history} onOpenRun={onOpenRun} />
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {observeNote}
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
      <WorkflowRunHistory runs={history} onOpenRun={onOpenRun} />
    </div>
  );
}

/**
 * Recent recorded runs — the durable history behind the live monitor, read
 * from each run's own evidence log by `agentstack workflow runs`. Answers
 * "did my run work?" after the fact; `interrupted` rows are resumable via
 * `workflow run <name> --resume <id>`.
 */
function WorkflowRunHistory({
  runs,
  onOpenRun,
}: {
  runs: ReadonlyArray<AgentstackWorkflowRunSummary>;
  onOpenRun: (run: AgentstackWorkflowRunSummary) => void;
}) {
  if (runs.length === 0) return null;
  // The popover is a glance surface: show the newest few, point at the CLI
  // for the rest (the dialog and `workflow runs` carry the full history).
  const shown = runs.slice(0, 6);
  const older = runs.length - shown.length;
  return (
    <div className="flex flex-col p-2 pt-0">
      <div className="flex items-center gap-2 px-1 py-1.5">
        <span className="text-[11px] font-bold tracking-wide text-muted-foreground">
          Recent runs
        </span>
        <span className="h-px flex-1 bg-border/60" />
      </div>
      {shown.map((r) => {
        const dur = fmtDuration(r.duration_ms);
        // Calm when fine: a completed run is just a green dot. Badges are
        // reserved for the states that ask something of the user.
        const badge = r.resumable
          ? { label: "resumable", className: "bg-warning/10 text-warning" }
          : r.outcome === "failed"
            ? { label: "failed", className: "bg-destructive/10 text-destructive" }
            : null;
        return (
          <button
            key={r.run}
            type="button"
            onClick={() => onOpenRun(r)}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                STEP_DOT[r.outcome] ?? "bg-muted-foreground/50",
              )}
            />
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate text-xs font-medium text-foreground">{r.workflow}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                {r.run}
              </span>
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {fmtAgo(r.started_unix)}
              {dur ? ` · ${dur}` : ""} · {r.steps} step{r.steps === 1 ? "" : "s"}
            </span>
            {badge ? (
              <span
                className={cn(
                  "inline-flex h-[17px] shrink-0 items-center rounded px-1.5 text-[10px] font-semibold",
                  badge.className,
                )}
              >
                {badge.label}
              </span>
            ) : null}
          </button>
        );
      })}
      {older > 0 ? (
        <span className="px-2 pt-1 text-[10px] text-muted-foreground/60">
          {older} older run{older === 1 ? "" : "s"} ·{" "}
          <code className="font-mono">agentstack workflow runs</code>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The expanded workflow monitor (design frame 1c, right pane) as a large
 * dialog: the full stage/agent tree for one run. A live run streams from the
 * popover's polling; a recorded run renders its evidence as fetched — same
 * join, never reconstructed. Opened from the live strip's "View agents →"
 * and from Recent-runs rows.
 */
function WorkflowMonitorDialog({
  target,
  run,
  onClose,
}: {
  target: { runId: string; summary: AgentstackWorkflowRunSummary | null } | null;
  run: AgentstackWorkflowRun | null;
  onClose: () => void;
}) {
  if (target === null) return null;
  const summary = target.summary;
  const outcome = run?.outcome ?? summary?.outcome ?? "running";
  const live = outcome === "running";
  const pinned = shortDigest(run?.workflow_digest ?? undefined);
  const dur = fmtDuration(run?.duration_ms ?? summary?.duration_ms);
  const counts = run ? deriveWorkflowCounts(run.steps) : null;
  const stages = run ? deriveWorkflowStages(run.steps).stages : [];
  const steps = run?.steps ?? [];
  const stepName = new Map(steps.map((s) => [s.step, s.label ?? `step ${s.step}`]));
  const totalToolCalls = steps.reduce((n, s) => n + (s.tool_calls ?? 0), 0);
  const elapsed =
    live && summary !== null
      ? fmtDuration((Math.floor(Date.now() / 1000) - summary.started_unix) * 1000)
      : null;
  // Density rule (design 2b): cards read well up to a dozen steps; a bigger
  // fan-out renders as one-line rows so the whole run stays scannable.
  const dense = steps.length > 12;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 pr-8">
            <span
              className={cn(
                "size-[7px] shrink-0 rounded-full",
                STEP_DOT[outcome] ?? "bg-muted-foreground/50",
              )}
            />
            <span className="truncate">{run?.workflow ?? summary?.workflow ?? target.runId}</span>
            <span className="ml-auto shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {live
                ? `live${elapsed ? ` · ${elapsed}` : ""}`
                : dur
                  ? `${outcome} · ${dur}`
                  : outcome}
            </span>
          </DialogTitle>
          <div className="flex items-center gap-2 pt-1">
            {pinned ? (
              <code className="font-mono text-[10px] text-muted-foreground">pinned {pinned}</code>
            ) : null}
            <span className="inline-flex h-[17px] items-center rounded bg-success/10 px-1.5 text-[10px] font-semibold text-success">
              every step: locked run
            </span>
            {run ? (
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">
                agents {steps.length}/{run.max_agents}
                {totalToolCalls ? ` · ${totalToolCalls} tool calls` : ""}
              </span>
            ) : (
              <code className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                {target.runId}
              </code>
            )}
          </div>
        </DialogHeader>
        {run === null ? (
          <DialogPanel>
            <p className="py-4 text-xs text-muted-foreground">Reading run evidence…</p>
          </DialogPanel>
        ) : (
          <DialogPanel className="flex flex-col gap-1">
            {/* The coordinator (design 2a): the envelope process itself —
                brokered spawns only, no role, no code access. */}
            <div className="mb-1 flex items-center gap-2 rounded-lg bg-foreground/[0.03] px-2.5 py-1.5">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  live ? "bg-warning animate-pulse" : "bg-muted-foreground/50",
                )}
              />
              <span className="shrink-0 text-[11px] font-semibold text-foreground">
                orchestrator
              </span>
              <code className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {target.runId}
              </code>
              <span className="truncate text-[11px] text-muted-foreground">
                schedules &amp; gates every spawn · touches no code
              </span>
              <span className="ml-auto inline-flex h-4 shrink-0 items-center rounded bg-foreground/[0.06] px-1.5 text-[10px] font-semibold text-muted-foreground">
                role: none
              </span>
            </div>
            {stages.map((stage) => {
              const done = stage.steps.filter((s) => s.state === "completed").length;
              return (
                <div key={stage.key}>
                  <div className="flex items-center gap-2 py-1.5">
                    <span className="text-[11px] font-bold tracking-wide text-muted-foreground">
                      {stage.title}
                    </span>
                    <span className="text-[10.5px] tabular-nums text-muted-foreground/70">
                      {done}/{stage.steps.length} done
                    </span>
                    <span className="h-px flex-1 bg-border/60" />
                  </div>
                  <div
                    className={cn(
                      "ml-1 border-l-2 pl-3",
                      live ? "border-warning/25" : "border-border/60",
                      dense ? "flex flex-col" : "grid grid-cols-2 gap-1.5",
                    )}
                  >
                    {stage.steps.map((s) => {
                      const stepDur = fmtDuration(s.duration_ms);
                      const inputs =
                        s.taint && s.taint.length > 0
                          ? s.taint.map((t) => stepName.get(t) ?? `step ${t}`).join(" · ")
                          : null;
                      if (dense) {
                        return (
                          <div
                            key={s.step}
                            className="flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-foreground/[0.03]"
                          >
                            <span
                              className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                STEP_DOT[s.state] ?? "bg-muted-foreground/50",
                              )}
                            />
                            <span className="w-36 truncate text-xs font-medium text-foreground">
                              {s.label ?? `step ${s.step}`}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground">
                              {s.state}
                              {stepDur ? ` · ${stepDur}` : ""}
                              {s.tool_calls ? ` · ${s.tool_calls} tool calls` : ""}
                              {s.child_run_id ? ` · ${s.child_run_id}` : ""}
                            </span>
                            {inputs ? (
                              <span className="max-w-44 shrink-0 truncate text-[10px] text-warning/90">
                                ⇠ {inputs}
                              </span>
                            ) : null}
                            <span className="inline-flex h-4 shrink-0 items-center rounded bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
                              {s.role}
                            </span>
                          </div>
                        );
                      }
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
                              {stepDur ? ` · ${stepDur}` : ""}
                              {s.tool_calls ? ` · ${s.tool_calls} tool calls` : ""}
                              {s.child_run_id ? ` · ${s.child_run_id}` : ""}
                            </span>
                            {inputs ? (
                              <span className="truncate text-[10px] text-warning/90">
                                ⇠ {inputs}
                              </span>
                            ) : null}
                          </div>
                          <span className="inline-flex h-4 shrink-0 items-center rounded bg-warning/10 px-1.5 text-[10px] font-semibold text-warning">
                            {s.role}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {summary?.resumable ? (
              <div className="mt-1 flex flex-col gap-1 rounded-lg border border-warning/25 bg-warning/[0.07] px-2.5 py-2">
                <span className="text-[11px] font-semibold text-warning">Resumable</span>
                <span className="text-[11px] text-muted-foreground">
                  No terminal outcome was recorded. Journaled steps replay without re-executing:
                </span>
                <code className="font-mono text-[10.5px] text-foreground">
                  agentstack workflow run {run.workflow} --resume {run.run}
                </code>
              </div>
            ) : null}
          </DialogPanel>
        )}
        <DialogFooter className="items-center gap-3 text-[11px] sm:justify-start">
          {counts ? (
            <span className="text-muted-foreground">
              <span className="font-semibold text-success">{counts.done} done</span>
              {counts.running > 0 ? (
                <>
                  {" · "}
                  <span className="font-semibold text-warning">{counts.running} running</span>
                </>
              ) : null}
            </span>
          ) : null}
          {run?.exhausted ? (
            <span className="font-semibold text-warning">agent ceiling exhausted</span>
          ) : null}
          <span className="ml-auto text-muted-foreground/70">
            roles can only narrow · ceilings frozen at spawn
          </span>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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
                        {dur ? ` · ${dur}` : ""}
                        {s.tool_calls ? ` · ${s.tool_calls} tool calls` : ""}
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

/**
 * The collapsed entry to the deeper views, rendered under the Overview. One
 * quiet row per view — a label plus its outcome hint — so the beginner surface
 * stays the four jobs while everything else remains one tap away.
 */
function AdvancedNav({
  onOpen,
  workflowLive,
}: {
  onOpen: (tab: Tab) => void;
  workflowLive: boolean;
}) {
  return (
    <div className="mx-1.5 mb-1.5 mt-1 border-t border-border/50 pt-1.5">
      {(Object.keys(ADVANCED_VIEWS) as Array<Exclude<Tab, "overview">>).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onOpen(t)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[6px] text-left transition-colors hover:bg-foreground/[0.04]"
        >
          <span className="text-[12px] font-medium text-foreground">{ADVANCED_VIEWS[t].title}</span>
          {t === "workflow" && workflowLive ? (
            <span className="size-[5px] rounded-full bg-warning animate-pulse" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
            {ADVANCED_VIEWS[t].hint}
          </span>
          <span className="text-[11px] text-muted-foreground/50">→</span>
        </button>
      ))}
    </div>
  );
}

/**
 * "Share this setup" — rung 5 of the product's ladder, which the panel had no
 * surface for at all: you could unify, switch, diagnose, recover and govern
 * here, but nothing told you how to get the same setup onto a second machine
 * or to a teammate.
 *
 * Read-only by design. Committing, signing, syncing a library and exporting a
 * bundle are CLI-owned, and two of them take a signing key or a passphrase
 * that must never enter a browser payload — so this explains what travels and
 * hands over the exact command, the same division the secret-blocked card
 * uses. It states the guarantee (references travel, values do not) before the
 * mechanics, because that is the question people actually have.
 */
function SharePanel({ doctor }: { doctor: AgentstackStatus["doctor"] }) {
  const facts = deriveAgentstackShareFacts(doctor);
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-xs">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The manifest and <code className="font-mono">agentstack.lock</code> are the setup. Commit
        them and another machine reproduces it — each supplies its own secret values.
      </p>

      <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-foreground/[0.02] px-2.5 py-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
          What travels
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Server and skill definitions, instructions, settings, and{" "}
          {facts.secretRefs > 0 ? (
            <>
              the <span className="font-semibold text-foreground">{facts.secretRefs}</span> secret{" "}
              {facts.secretRefs === 1 ? "reference" : "references"} this project uses — as{" "}
              <code className="font-mono">{"${REF}"}</code> names only.
            </>
          ) : (
            <>
              any <code className="font-mono">{"${REF}"}</code> names — placeholders only.
            </>
          )}{" "}
          <span className="text-muted-foreground/70">
            Secret values never enter the manifest, the lockfile, or this panel.
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
          Pin it first
        </p>
        {facts.pinning ? (
          <div className="flex items-start gap-2">
            <span
              className={cn("mt-1 size-1.5 shrink-0 rounded-full", LEVEL_DOT[facts.pinning.level])}
            />
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              {facts.pinning.msg}
            </span>
          </div>
        ) : null}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <code className="font-mono">lock</code> resolves every reference to exact bytes, so a
          teammate gets what you got — and a later change is visible instead of silent.
        </p>
        <CommandLine text="agentstack lock --write" />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
          Across your own machines
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The central library travels as a git repo; server definitions keep their{" "}
          <code className="font-mono">{"${REF}"}</code> placeholders, so no secret leaves this
          machine.
        </p>
        <CommandLine text="agentstack lib sync" />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
          To a teammate
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Commit the manifest and lockfile. To let them verify the lockfile is yours, sign it and
          publish the printed public key; they verify before trusting.
        </p>
        <CommandLine text="agentstack sign" />
        <CommandLine text="agentstack verify --pubkey <key>" />
        <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
          Moving a whole machine instead? <code className="font-mono">agentstack export</code>{" "}
          writes an encrypted bundle and <code className="font-mono">agentstack import</code> reads
          it — the one path that can carry secret values, behind a passphrase you type in a
          terminal.
        </p>
      </div>
    </div>
  );
}

/**
 * "More protection": the stronger modes in one place, each labelled with what
 * it actually covers and what it costs — never a claim the selected mode does
 * not enforce. The raw machine-policy/policy doctor lines stay available under
 * a Details disclosure for the precise version.
 */
function ProtectionPanel({
  doctor,
  actionState,
  onRequestAction,
  onConfirm,
  onCancel,
}: {
  doctor: AgentstackStatus["doctor"];
  actionState: ActionState;
  onRequestAction: (a: ActionKind) => void;
  onConfirm: (a: ActionKind) => void;
  onCancel: () => void;
}) {
  if (!doctor) {
    return (
      <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        The machine policy is the ceiling every session runs under — no repo can loosen it.
      </p>
    );
  }
  const rows = deriveAgentstackProtectionRows(doctor);
  const policyRows = deriveAgentstackPolicyRows(doctor);
  return (
    <div className="flex flex-col p-1.5">
      <p className="px-2.5 pb-1.5 pt-1 text-[11px] leading-relaxed text-muted-foreground">
        Normal setup already fails closed. These layers add stronger checks — each says what it
        covers and what it costs.
      </p>
      {rows.map((row) => (
        <div key={row.key} className="flex items-start gap-2.5 rounded-lg px-2.5 py-[7px]">
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", LEVEL_DOT[row.level])} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[12.5px] font-semibold text-foreground">{row.label}</span>
            <span className="text-xs leading-relaxed text-muted-foreground">{row.summary}</span>
            {row.cost ? (
              <span className="text-[11px] text-muted-foreground/60">{row.cost}</span>
            ) : null}
          </div>
          {row.action ? (
            <button
              type="button"
              onClick={() => onRequestAction(row.action!)}
              className="mt-0.5 shrink-0 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning transition-colors hover:bg-warning/20"
            >
              {ACTION_META[row.action].label}
            </button>
          ) : null}
        </div>
      ))}
      {actionState.phase !== "idle" ? (
        <ActionConfirm state={actionState} onConfirm={onConfirm} onCancel={onCancel} />
      ) : null}
      {policyRows.length > 0 ? (
        <details className="mx-1 mb-1 mt-1.5 rounded-lg border border-border/50 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            Details — the exact policy lines
          </summary>
          <div className="flex flex-col gap-2 pb-1 pt-2">
            {policyRows.map((row) => (
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
        </details>
      ) : null}
    </div>
  );
}
