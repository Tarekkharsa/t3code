import type {
  AgentstackActiveSession,
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
  AgentstackToolset,
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

import { useAgentstackPanelStore, type AgentstackPanelTab } from "~/agentstackPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { agentstackEnvironment } from "~/state/agentstack";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AgentstackMark } from "./AgentstackMark";
import {
  AGENTSTACK_ACTION_META as ACTION_META,
  agentstackFeatureKnownMissing,
  deriveAgentstackActivityRows,
  deriveAgentstackFindings,
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
  formatAgentstackCount,
  formatAgentstackImportSummary,
  hasAgentstackFeature,
  matchAgentstackNextAction,
  partitionAgentstackOverviewRows,
  selectAgentstackFindingsView,
  selectAgentstackPrimaryConcern,
  selectAgentstackUndoEntry,
  shortDigest,
  shortenAgentstackPath,
  shortenAgentstackPathsIn,
  summarizeAgentstackHealthyRows,
  type AgentstackActionKind as ActionKind,
  type AgentstackFinding,
  type AgentstackOverviewRow,
  type AgentstackPrimaryConcern,
  type AgentstackRowLevel,
  type AgentstackToolsetRow,
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
/** Creating a toolset stopped activating it: on a CLI advertising this,
 *  `create-profile` writes the manifest entry and re-locks and renders NOTHING,
 *  so the new toolset is declared but not in use. Its own name rather than a
 *  wider reading of `profiles-edit-v1`, because a binary advertising only that
 *  older name legitimately DOES re-render on create — telling that user to
 *  "activate it now" would offer a second activation of something already
 *  active. Absent/unknown features therefore keep the old reading. */
const FEATURE_TOOLSET_CREATE_V2 = "toolset-create-v2";
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

/**
 * Text colour paired with LEVEL_DOT.
 *
 * Only an error earns coloured words. A realistic report puts a warning on
 * nearly every visible line — manifest, secrets, library, plus each finding —
 * and amber applied to all of the prose discriminates none of it; the dot
 * already carries the level. Reserving colour for the error is what makes the
 * one thing that gates the project the one thing that is coloured.
 */
const LEVEL_TEXT: Record<AgentstackRowLevel, string> = {
  ok: "text-foreground/80",
  warn: "text-foreground",
  error: "text-destructive-foreground",
  muted: "text-muted-foreground",
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

/**
 * Poll cadence while a workflow run is being watched. Nothing polls while
 * every AgentStack surface is closed.
 */
const LIVE_REFRESH_MS = 5_000;

/**
 * Poll cadence when nothing is moving.
 *
 * Each refresh spawns FOUR `agentstack` processes, and `doctor` resolves every
 * `${REF}` the manifest names on every run — it reads the actual value out of
 * the OS keychain purely to print which layer it came from. On macOS each such
 * read is an ACL check, so a project with two keychain-backed secrets was
 * generating twenty-four keychain reads a minute for a panel sitting idle
 * behind a dialog. Whenever the binary's identity changes (any rebuild voids
 * the "Always Allow" grant, which is keyed to the code signature) that turns
 * into a password prompt storm.
 *
 * Nothing on these surfaces except a live run changes second to second — drift
 * and findings are the product of edits the user just made, and every write the
 * panel performs refreshes explicitly. So the idle cadence is a heartbeat, and
 * `LIVE_REFRESH_MS` applies only while a run is actually being watched.
 */
const IDLE_REFRESH_MS = 30_000;

type Tab = AgentstackPanelTab;

/**
 * The Manage dialog's four tabs — the panel's entire navigation model.
 *
 * Everything the popover used to reach through a back-stack (Share, More
 * protection, Activity, Workflows, Library, Checkup) is one of these four
 * groups, side by side in a 768px dialog. No "← Back", no navigation state to
 * remember, and each tab has room for the detail the 400px column had to clip.
 */
const MANAGE_TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "toolsets", label: "Toolsets" },
  { id: "protection", label: "Protection" },
  { id: "activity", label: "Activity" },
];

type ActionState =
  | { phase: "idle" }
  | { phase: "confirm"; action: ActionKind }
  | { phase: "running"; action: ActionKind }
  | { phase: "done"; ok: boolean; message: string };

/**
 * Just the version, from the CLI's `agentstack 0.16.0 (sandbox: no)` line.
 *
 * The trailing parenthetical is a BUILD flag — whether this binary was
 * compiled with sandbox support — and it was being drawn next to the version
 * as if it were a fact about the user's project. Someone reading "sandbox: no"
 * beside their version reasonably concludes their setup is unsandboxed, which
 * is a claim about enforcement that this string is not making.
 */
/**
 * `<base>/x/y` → `x/y`, or null when the path isn't inside the base.
 *
 * t3code's file viewer addresses files by workspace-relative path; the CLI
 * reports the manifest as an absolute one. Null rather than a best guess: a
 * manifest outside the workspace (an explicit `--manifest-dir`, a symlinked
 * checkout) is exactly the case where a fabricated relative path would open
 * some unrelated file that happens to sit at the same offset.
 */
function relativeToBase(base: string, absolute: string): string | null {
  const root = base.endsWith("/") ? base : `${base}/`;
  return absolute.startsWith(root) ? absolute.slice(root.length) : null;
}

function shortAgentstackVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const version = raw
    .replace(/^agentstack\s*/, "")
    .replace(/\s*\(.*$/, "")
    .trim();
  return version.length > 0 ? `v${version}` : null;
}

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
  /** Null = the Manage dialog is closed; otherwise the tab it is showing. */
  const [manageTab, setManageTab] = useState<Tab | null>(null);
  const [status, setStatus] = useState<AgentstackStatus | null>(null);
  const [activity, setActivity] = useState<AgentstackActivity | null>(null);
  const [workflow, setWorkflow] = useState<AgentstackWorkflowData | null>(null);
  const [toolsets, setToolsets] = useState<AgentstackToolsetsResult | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [actionState, setActionState] = useState<ActionState>({ phase: "idle" });
  const [reviewing, setReviewing] = useState(false);
  const [reviewingDrift, setReviewingDrift] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  /** Open a reading screen: the popover yields so only one surface is up. */
  const openReader = useCallback((show: (v: true) => void) => {
    setOpen(false);
    show(true);
  }, []);
  /** Same, for the tabbed Manage dialog. */
  const openManage = useCallback((t: Tab) => {
    setOpen(false);
    setManageTab(t);
  }, []);
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

  // Only a run in flight justifies the fast cadence. `watchingRun` is derived
  // from what a previous refresh already reported, so a run that starts while
  // the panel idles is picked up on the next heartbeat and the poll speeds up
  // from there.
  const watchingRun =
    monitorTarget !== null ||
    (workflow?.activeRun != null && workflow.activeRun.outcome === "running");
  useEffect(() => {
    // The monitor and Manage dialogs keep polling alive after the popover
    // closes, so a live run's step tree — and the Manage tabs — stay current
    // while they're being read.
    if (!open && monitorTarget === null && manageTab === null) return;
    void refresh();
    const period = watchingRun ? LIVE_REFRESH_MS : IDLE_REFRESH_MS;
    const timer = setInterval(() => void refresh(), period);
    return () => clearInterval(timer);
  }, [open, monitorTarget, manageTab, watchingRun, refresh]);

  // React to "open me on tab X" requests from elsewhere (e.g. a guard-denial
  // card's "View in audit log"). The nonce makes repeat requests re-fire.
  const panelOpenNonce = useAgentstackPanelStore((s) => s.openNonce);
  const panelRequestedTab = useAgentstackPanelStore((s) => s.requestedTab);
  useEffect(() => {
    if (panelOpenNonce === 0) return;
    setOpen(false);
    setManageTab(panelRequestedTab);
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

  // Trust no longer draws a pill of its own: green said nothing, and the two
  // states that matter (inert, drifted) are the first page's top concern.
  const trust = status?.doctor ? deriveAgentstackTrustBadge(status.doctor) : null;

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
  // Creating a toolset no longer renders it into the CLI configs, so the panel
  // must stop implying the new toolset is in use and point at the activation
  // step instead. Gated positively: an older auto-rendering binary (or a CLI
  // that advertises nothing) keeps the previous copy, so nobody is nudged into
  // activating what is already active.
  const createNeedsActivation = hasAgentstackFeature(features, FEATURE_TOOLSET_CREATE_V2);
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

  // Every error and warning doctor reported, with the fix it named. The Checkup
  // row summarized these as a count and showed none of them; the list below the
  // row is where they finally appear.
  const findings = useMemo(() => deriveAgentstackFindings(status?.doctor ?? null), [status]);

  // The first page shows ONE problem. Everything else it would have listed is
  // counted here and read in Manage.
  const concern = useMemo(
    () =>
      status?.doctor
        ? selectAgentstackPrimaryConcern({
            rows: overviewRows,
            findings,
            trust: trust?.state ?? "unknown",
          })
        : null,
    [status, overviewRows, findings, trust],
  );

  const healthyLine = useMemo(
    () => summarizeAgentstackHealthyRows(partitionAgentstackOverviewRows(overviewRows).healthy),
    [overviewRows],
  );

  // Open the manifest in t3code's own file viewer.
  //
  // The panel can add to a toolset but cannot fix a bad server definition, and
  // several checkup findings have no remedy except editing the manifest — so
  // the honest affordance is to hand you the source of truth rather than a
  // command to go type somewhere else. Null (and the button hidden) whenever
  // we cannot name the file exactly: no thread to host the viewer, an older
  // CLI that doesn't report the path, or a manifest outside this workspace.
  const manifestSource = toolsets?.toolsets ?? null;
  const onOpenManifest = useMemo(() => {
    const absolute = manifestSource?.manifest_path ?? null;
    const base = manifestSource?.path ?? null;
    if (threadId === undefined || absolute === null || base === null) return null;
    const relative = relativeToBase(base, absolute);
    if (relative === null) return null;
    return () => {
      setManageTab(null);
      useRightPanelStore.getState().openFile({ environmentId, threadId }, relative);
    };
  }, [manifestSource, threadId, environmentId]);

  // Run the concern's one verb. `manage` and the two review kinds open a
  // surface; only `action` writes, and it still goes through the confirm step.
  const onConcern = useCallback(
    (c: AgentstackPrimaryConcern) => {
      switch (c.act.kind) {
        case "action":
          setActionState({ phase: "confirm", action: c.act.action });
          break;
        case "review-drift":
          openReader(setReviewingDrift);
          break;
        case "review-trust":
          openReader(setReviewing);
          break;
        case "manage":
          openManage("setup");
          break;
      }
    },
    [openManage, openReader],
  );

  return (
    <>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          // Only the popover's own transient state resets here. The dialogs
          // below are siblings with their own lifetime — clearing them here
          // meant dismissing the popover silently killed an open review.
          if (!next) setActionState({ phase: "idle" });
        }}
        open={open}
      >
        <PopoverTrigger render={<Button aria-label="AgentStack" size="xs" variant="outline" />}>
          <AgentstackMark className="size-3.5" />
          {/* The header dot is the same claim the panel makes when opened:
              one concern, or a live run. Deriving it separately is how the
              icon ends up warning about something the panel then doesn't
              show. */}
          {activeRun ? (
            <span aria-hidden className="-mr-0.5 size-1.5 rounded-full bg-warning animate-pulse" />
          ) : concern ? (
            <span aria-hidden className="-mr-0.5 size-1.5 rounded-full bg-warning" />
          ) : null}
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[400px] p-0" side="bottom">
          {/* Header — the mark, the name, and one word for the state. The
              version number, the trust pill and the readiness chip all used to
              sit here; a build fact and two pills saying the same thing are
              not what someone opens this for. */}
          <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
            <AgentstackMark className="size-[22px]" />
            <span className="font-semibold text-sm text-foreground">AgentStack</span>
            {status?.installed && status.doctor ? (
              <span
                className={cn(
                  "ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px]",
                  concern ? "text-warning-foreground" : "text-muted-foreground",
                )}
              >
                {/* No pulse here: the live-run strip below is already the
                    animated thing on screen, and two of them read as two
                    separate events. */}
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", concern ? "bg-warning" : "bg-success")}
                />
                {concern ? "Needs you" : "Ready"}
              </span>
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
              <span className="ml-auto text-xs font-medium text-warning-foreground">
                View agents →
              </span>
            </button>
          ) : null}

          {/* Body — exactly one region: the blocked state, the one problem,
              or the toolset you're working under. */}
          {status?.installed && incompatible ? (
            <UpdateNeeded incompatible={incompatible} cliVersion={status.version} />
          ) : status?.installed && setupState === "needs_setup" ? (
            <NeedsSetup onOpen={() => openReader(setSettingUp)} />
          ) : unreachable ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">
              Couldn't check status — the t3code server didn't answer.
            </p>
          ) : status === null ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">Checking…</p>
          ) : !status.installed ? (
            <NotInstalled onRecheck={refresh} />
          ) : status.doctor === null ? (
            <DoctorUnreadable onRecheck={refresh} />
          ) : (
            <>
              {concern ? (
                <ConcernCard concern={concern} onAct={() => onConcern(concern)} />
              ) : (
                <WorkingUnder
                  toolsets={toolsets}
                  canSessions={canSessions}
                  onSwitch={() => openManage("toolsets")}
                  onEnd={onSessionEnd}
                />
              )}
              {/* The one write the first page can start still confirms — the
                  confirm is the consent, and it is never skipped. */}
              {actionState.phase !== "idle" ? (
                <div className="px-1.5 pb-1">
                  <ActionConfirm
                    state={actionState}
                    onConfirm={onAction}
                    onCancel={() => setActionState({ phase: "idle" })}
                  />
                </div>
              ) : null}

              {/* Footer — one sentence about everything not shown, and the
                  door to it. */}
              <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
                  {concern
                    ? concern.others > 0
                      ? `${formatAgentstackCount(concern.others, "more finding")} in Manage`
                      : "Nothing else needs you."
                    : (healthyLine ?? "This project is set up and in sync.")}
                </span>
                <button
                  type="button"
                  onClick={() => openManage("setup")}
                  className="shrink-0 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Manage ›
                </button>
              </div>
            </>
          )}
        </PopoverPopup>
      </Popover>
      {manageTab !== null ? (
        <ManageDialog
          tab={manageTab}
          onTab={setManageTab}
          onClose={() => setManageTab(null)}
          version={status?.version}
          workflowLive={activeRun !== null}
          status={status}
          activity={activity}
          workflow={workflow}
          workflowIncompatible={workflowIncompatible}
          workflowObserveKnownMissing={workflowObserveKnownMissing}
          toolsets={toolsets}
          rows={overviewRows}
          findings={findings}
          features={features}
          advisories={canReadAdvisories ? (status?.doctor?.advisories ?? null) : null}
          canRestore={canRestore}
          canSessions={canSessions}
          sessionsKnownMissing={sessionsKnownMissing}
          canEditProfiles={canEditProfiles}
          canRemoveFromLibrary={canRemoveFromLibrary}
          createNeedsActivation={createNeedsActivation}
          actionState={actionState}
          onRequestAction={(a) => setActionState({ phase: "confirm", action: a })}
          onConfirm={onAction}
          onCancelAction={() => setActionState({ phase: "idle" })}
          onReviewDrift={() => {
            setManageTab(null);
            setReviewingDrift(true);
          }}
          onOpenRun={(r) => setMonitorTarget({ runId: r.run, summary: r })}
          loadRestoreInventory={loadRestoreInventory}
          onUndo={onUndo}
          onSessionStart={onSessionStart}
          onSessionEnd={onSessionEnd}
          loadLibraryIndex={loadLibraryIndex}
          previewProfileEdit={previewProfileEdit}
          applyProfileEdit={applyProfileEdit}
          onRecheck={refresh}
          onOpenManifest={onOpenManifest}
        />
      ) : null}
      {/* Screens you read, not glance at — see PanelDialog. Rendered beside the
          popover rather than inside it, so opening one never blanks status. */}
      {reviewing ? (
        <PanelDialog
          title="Review this project"
          description="What this project would be allowed to run here, before you approve it."
          onClose={() => setReviewing(false)}
        >
          <TrustReviewPanel
            loadPreview={loadPreview}
            onTrust={onTrust}
            onClose={() => setReviewing(false)}
            trustConsentMissing={trustConsentMissing}
          />
        </PanelDialog>
      ) : null}
      {reviewingDrift ? (
        <PanelDialog
          title="Review drift"
          description="What changed on disk since AgentStack last wrote, and which truth to keep."
          onClose={() => setReviewingDrift(false)}
          width="max-w-3xl"
        >
          <DriftReviewPanel loadDiff={loadDiff} onAction={runDriftAction} />
        </PanelDialog>
      ) : null}
      {settingUp ? (
        <PanelDialog
          title="Set up this project"
          description="Import the coding tools already on this machine into one manifest."
          onClose={() => setSettingUp(false)}
        >
          <SetupPanel
            loadPlan={loadSetupPlan}
            onApply={async (choice, digest) => {
              const r = await onSetupApply(choice, digest);
              if (r.ok) setSettingUp(false);
              return r;
            }}
            canApply={canApplySetup}
          />
        </PanelDialog>
      ) : null}
      <WorkflowMonitorDialog
        target={monitorTarget}
        run={monitorRun}
        onClose={() => setMonitorTarget(null)}
      />
    </>
  );
}

/**
 * The popover's view of an unset-up project: say the state and offer the one
 * action, rather than rendering the whole setup plan into a 400px column. The
 * plan itself opens in a dialog where it has room to be read.
 */
function NeedsSetup({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-4">
      <p className="text-xs font-semibold text-foreground">This project isn't set up yet</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        AgentStack can import the coding tools already on this machine into one manifest your CLIs
        render from. You'll see exactly what it would write before anything is written.
      </p>
      <Button size="sm" onClick={onOpen} className="self-start">
        Review setup
      </Button>
    </div>
  );
}

/**
 * The first page when something needs the user: ONE problem, said as its
 * consequence, with one button and what that button promises.
 *
 * The popover used to render every non-ok row, a collapsed findings list, and
 * a "Next: <command>" line — three ways of describing the same repair, the
 * loudest of them a shell command the user can't type here. The command is
 * still shown, once, at the confirm step; what leads is the sentence that says
 * why it matters. Everything else it would have listed is counted in the
 * footer and read in Manage.
 */
export function ConcernCard({
  concern,
  onAct,
}: {
  concern: AgentstackPrimaryConcern;
  onAct: () => void;
}) {
  return (
    <div className="px-2.5 pb-2.5">
      <div className="flex flex-col gap-2 rounded-lg border border-warning/25 bg-warning/[0.07] px-3 py-2.5">
        <p className="text-[13px] font-semibold leading-snug text-foreground">{concern.title}</p>
        {concern.detail ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{concern.detail}</p>
        ) : null}
        <div className="flex items-center gap-2.5">
          <Button size="xs" variant="default" onClick={onAct} className="font-semibold">
            {concern.label}
          </Button>
          {concern.note ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {concern.note}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The first page when nothing needs the user: which toolset this project is
 * working under, and the one verb that changes it.
 *
 * This is the frame you see in nine sessions out of ten, and it used to offer
 * a version number, a trust pill, a readiness chip, a reassurance line, a
 * collapsed checkup, an undo button and four navigation rows — nine regions,
 * none of which is what you opened the panel to find out. Switching toolsets
 * is; so that is what is here.
 */
export function WorkingUnder({
  toolsets,
  canSessions,
  onSwitch,
  onEnd,
}: {
  toolsets: AgentstackToolsetsResult | null;
  canSessions: boolean;
  onSwitch: () => void;
  onEnd: () => Promise<{ ok: boolean; message: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const data = toolsets?.toolsets ?? null;
  const session = data?.session ?? null;
  const rows = useMemo(() => (data ? deriveToolsetRows(data.profiles, data.trust) : []), [data]);
  // What the project is actually working under: the temporary session if one
  // is open, else the profile the CLI marked active. Never guessed from the
  // first declared profile — an unowned name here would be a lie about scope.
  const active = session?.profile ?? rows.find((r) => r.active)?.name ?? null;
  const row = active === null ? null : (rows.find((r) => r.name === active) ?? null);

  if (active === null) {
    return (
      <div className="flex items-center gap-2 px-4 pb-3 pt-0.5">
        <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          {rows.length === 0
            ? "No toolsets yet — bundle the tools this project needs into one."
            : "No toolset is active. Pick one to apply it here."}
        </span>
        <Button size="xs" variant="outline" onClick={onSwitch} className="shrink-0">
          {rows.length === 0 ? "Create one" : "Choose"}
        </Button>
      </div>
    );
  }

  return (
    <div className="px-2.5 pb-2.5">
      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-foreground/[0.02] px-3 py-2.5">
        <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
          WORKING UNDER
        </span>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {active}
          </span>
          {session && canSessions ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onEnd().finally(() => setBusy(false));
              }}
              className="shrink-0"
            >
              {busy ? "Stopping…" : "Stop using"}
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={onSwitch} className="shrink-0">
            Switch
          </Button>
        </div>
        <span className="truncate text-[11.5px] text-muted-foreground" title={row?.summary}>
          {row?.summary ?? "applied to this project"}
          {session ? ` · in use ${fmtAgo(session.started_unix)}` : ""}
        </span>
      </div>
    </div>
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
        <p className="text-xs font-semibold text-foreground">Install</p>
        <p>
          Build or download it from{" "}
          <code className="break-all font-mono text-muted-foreground/90">
            github.com/Tarekkharsa/agentstack
          </code>
          , then put <code className="font-mono">agentstack</code> on your <code>PATH</code>.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-semibold text-foreground">Already installed?</p>
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
    <div>
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
            <p className="mb-1 text-xs font-semibold text-foreground">
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
                      <p className="mb-1 text-xs font-semibold text-foreground">
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
                      <p className="mb-1 text-xs font-semibold text-foreground">
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
            <p className="text-[11px] leading-relaxed text-warning-foreground">
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
              <span
                className={cn(
                  "font-semibold",
                  act.ok ? "text-success-foreground" : "text-destructive-foreground",
                )}
              >
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
                className="inline-flex h-7 items-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive-foreground disabled:opacity-60"
              >
                {running ? "Revoking…" : "Revoke trust"}
              </button>
            ) : (
              <button
                type="button"
                disabled={running || !canGrant}
                onClick={() => run("trust-grant")}
                className="inline-flex h-7 items-center rounded-lg border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success-foreground disabled:opacity-60"
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
      <p className="mb-1 text-xs font-semibold text-foreground">
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
 *
 * The verb acts on click. This screen already shows the diff and states both
 * outcomes beside their buttons, so the second confirm restated a decision the
 * user had just read the evidence for — the choice IS the consent here, and
 * the safe verb is weighted so the ranking is visible before the click, not
 * argued about after it.
 */
function DriftReviewPanel({
  loadDiff,
  onAction,
}: {
  loadDiff: (scope: "global" | "project") => Promise<AgentstackDiffResult | null>;
  onAction: (action: ActionKind) => Promise<{ ok: boolean; message: string }>;
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
    <div>
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
                onPick={(action) => void run(action)}
              />
            ) : null,
          )}

          {act.phase === "done" ? (
            <div
              className={cn(
                "rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
                act.ok
                  ? "border-success/30 bg-success/[0.06]"
                  : "border-destructive/30 bg-destructive/[0.06]",
              )}
            >
              <span
                className={cn(
                  "font-semibold",
                  act.ok ? "text-success-foreground" : "text-destructive-foreground",
                )}
              >
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
  onPick: (action: ActionKind) => void;
}) {
  const changed = report.targets.filter((t) => t.changed);
  const kept = keptServers(report);
  if (changed.length === 0 && kept.length === 0) return null;

  const where = scope === "global" ? "global configs (~)" : "this repo";
  const adopt: ActionKind = scope === "global" ? "adopt-global" : "adopt-project";
  const apply: ActionKind = scope === "global" ? "apply-global" : "apply-project";

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-foreground">{where}</p>

      {changed.length > 0 ? (
        <>
          {changed.map((t) => (
            <DriftTarget key={`${scope}-${t.id}`} target={t} />
          ))}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The on-disk config in {where} was hand-edited. Pick which one is the truth.
          </p>
          {/* Ranked, not paired: "Keep edits" only writes agentstack.toml, so
              it is the non-destructive answer and reads as the default.
              "Re-render" overwrites the edit and says so on its own line
              rather than in a modal you dismiss before it takes effect. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(adopt)}
                className="inline-flex h-7 shrink-0 items-center rounded-lg border border-success/40 bg-success/10 px-3 text-xs font-semibold text-success-foreground disabled:opacity-60"
              >
                Keep edits
              </button>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Pull the hand-edit into this project's manifest. Only writes agentstack.toml.
              </span>
            </div>
            <div className="flex items-baseline gap-2.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(apply)}
                className="inline-flex h-7 shrink-0 items-center rounded-lg border border-border/60 px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
              >
                Re-render
              </button>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Overwrite the hand-edit from the manifest. Other setups' servers are kept, never
                pruned; reversible with <code className="font-mono">agentstack restore</code>.
              </span>
            </div>
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
              onClick={() => onPick(adopt)}
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

/** Everything the four tabs need. One bag, so the dialog stays one component. */
interface ManageProps {
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  version: string | null | undefined;
  workflowLive: boolean;
  status: AgentstackStatus | null;
  activity: AgentstackActivity | null;
  workflow: AgentstackWorkflowData | null;
  workflowIncompatible: AgentstackIncompatible | null;
  workflowObserveKnownMissing: boolean;
  toolsets: AgentstackToolsetsResult | null;
  rows: ReadonlyArray<AgentstackOverviewRow>;
  findings: ReadonlyArray<AgentstackFinding>;
  features: ReadonlyArray<string> | undefined;
  advisories: number | null;
  canRestore: boolean;
  canSessions: boolean;
  sessionsKnownMissing: boolean;
  canEditProfiles: boolean;
  canRemoveFromLibrary: boolean;
  /** Whether this CLI advertises `toolset-create-v2` — i.e. whether creating a
   *  toolset leaves it declared but NOT in use. False on an older binary, which
   *  still re-renders on create; the confirm copy and outcome card follow. */
  createNeedsActivation: boolean;
  actionState: ActionState;
  onRequestAction: (a: ActionKind) => void;
  onConfirm: (a: ActionKind) => void;
  onCancelAction: () => void;
  onReviewDrift: () => void;
  onOpenRun: (r: AgentstackWorkflowRunSummary) => void;
  loadRestoreInventory: () => Promise<AgentstackRestoreInventoryResult | null>;
  onUndo: (restoreId: string) => Promise<{ ok: boolean; message: string }>;
  onSessionStart: (profile: string) => Promise<{ ok: boolean; message: string }>;
  onSessionEnd: () => Promise<{ ok: boolean; message: string }>;
  loadLibraryIndex: () => Promise<AgentstackLibraryIndexResult | null>;
  previewProfileEdit: (
    edit: AgentstackProfileEdit,
  ) => Promise<AgentstackProfileEditPreviewResult | null>;
  applyProfileEdit: (
    edit: AgentstackProfileEdit,
    consentedDigest: string,
  ) => Promise<{ ok: boolean; message: string }>;
  onRecheck: () => Promise<void> | void;
  /** Open the manifest in t3code's file viewer; null when it can't be named. */
  onOpenManifest: (() => void) | null;
}

/**
 * Manage — everything that isn't the glance, in one dialog with four tabs.
 *
 * It replaces four look-alike navigation rows, a back-stack and two sibling
 * dialogs (Library, Checkup) with a flat, four-way choice at 768px. Nothing
 * here is new capability: Setup, Toolsets, Protection and Activity are the
 * screens the popover already had, given the width they were always being
 * clipped for, and reachable in one click instead of two plus "← Back".
 */
function ManageDialog(props: ManageProps) {
  const doctor = props.status?.doctor ?? null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 pr-8">
            <AgentstackMark className="size-[18px] shrink-0" />
            <span className="truncate">Manage AgentStack</span>
          </DialogTitle>
        </DialogHeader>

        {/* Tab bar. The version lives here — a build fact, on the surface
            where a build fact is what you came looking for. */}
        <div className="flex items-center gap-1 border-b border-border/60 px-1">
          {MANAGE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => props.onTab(t.id)}
              className={cn(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] transition-colors",
                props.tab === t.id
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.id === "activity" && props.workflowLive ? (
                <span className="rounded bg-warning/15 px-1 py-px text-[10px] font-semibold text-warning-foreground">
                  run live
                </span>
              ) : null}
            </button>
          ))}
          {shortAgentstackVersion(props.version) ? (
            <span className="ml-auto pr-2 font-mono text-[10.5px] text-muted-foreground/70">
              {shortAgentstackVersion(props.version)}
            </span>
          ) : null}
        </div>

        {/* A FIXED frame, not a max-height.
            With `max-h`, the dialog took its height from whichever tab was
            open — Setup is short, Protection is three screens — so every tab
            click resized the whole window under the pointer, and so did each
            inner view swap. The box is now constant; only what is inside it
            scrolls, and each tab owns its own scroll region so switching back
            returns you to where you were rather than to the top of a
            different-sized page. */}
        <div className="flex h-[min(600px,68vh)] flex-col overflow-hidden">
          {props.tab === "setup" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SetupTab {...props} />
            </div>
          ) : props.tab === "toolsets" ? (
            <ToolsetsTab {...props} />
          ) : props.tab === "protection" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabSection title="Stronger modes" first />
              <ProtectionPanel
                doctor={doctor}
                actionState={props.actionState}
                onRequestAction={props.onRequestAction}
                onConfirm={props.onConfirm}
                onCancel={props.onCancelAction}
              />
              <TabSection title="Sharing this setup" />
              <SharePanel doctor={doctor} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ActivityTab {...props} />
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Setup — is this project in sync, what did the checkup find, and how to take
 * a change back. The three questions the popover used to answer badly at
 * 400px, with room for the findings list to simply be open.
 */
function SetupTab(props: ManageProps) {
  const doctor = props.status?.doctor ?? null;
  if (doctor === null) return <DoctorUnreadable onRecheck={props.onRecheck} />;
  const { problems, healthy } = partitionAgentstackOverviewRows(props.rows);
  const healthyLine = summarizeAgentstackHealthyRows(healthy);
  const chip = deriveAgentstackStatusChip({
    state: doctor.state,
    protection: doctor.protection,
  });
  return (
    <div className="flex flex-col p-2.5">
      {chip ? (
        <StatusSummary
          chip={chip}
          nextAction={doctor.next_action ?? null}
          advisories={props.advisories}
          onRunNextAction={props.onRequestAction}
        />
      ) : null}
      {problems.map((row) => (
        <div key={row.key} className="flex items-start gap-2.5 rounded-lg px-2.5 py-[7px]">
          <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", LEVEL_DOT[row.level])} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">{row.label}</span>
            <span className={cn("text-xs leading-snug", LEVEL_TEXT[row.level])}>{row.summary}</span>
          </div>
          {row.reviewDrift ? (
            <RowAction onClick={props.onReviewDrift}>Review</RowAction>
          ) : row.action ? (
            <RowAction onClick={() => props.onRequestAction(row.action!)}>
              {ACTION_META[row.action].label}
            </RowAction>
          ) : null}
        </div>
      ))}
      <CheckupFindings
        findings={props.findings}
        features={props.features}
        onRequestAction={props.onRequestAction}
        onReviewDrift={props.onReviewDrift}
        alreadyOffered={matchAgentstackNextAction(doctor.next_action ?? null)}
        defaultOpen
      />
      {healthyLine !== null ? (
        <p className="flex items-center gap-2 px-2.5 py-1 text-[11px] text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-success/60" />
          {healthyLine}
        </p>
      ) : null}
      {props.actionState.phase !== "idle" ? (
        <ActionConfirm
          state={props.actionState}
          onConfirm={props.onConfirm}
          onCancel={props.onCancelAction}
        />
      ) : null}
      <UndoAffordance
        loadInventory={props.loadRestoreInventory}
        onUndo={props.onUndo}
        canRestore={props.canRestore}
      />
      <RecheckRow onRecheck={props.onRecheck} onOpenManifest={props.onOpenManifest} />
    </div>
  );
}

/**
 * Run the checkup again.
 *
 * The panel polls every five seconds while it's open, so this rarely changes
 * anything a wait wouldn't — but a screen listing seven warnings and offering
 * no way to ask "is that still true?" reads as a report you cannot argue with.
 * After fixing something in a terminal, this is the button you want, and it is
 * the same read `agentstack doctor` performs.
 */
function RecheckRow({
  onRecheck,
  onOpenManifest,
}: {
  onRecheck: () => Promise<void> | void;
  onOpenManifest: (() => void) | null;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-1 mt-1.5 flex items-center gap-2 border-t border-border/40 px-1.5 pt-2">
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onRecheck()).finally(() => setBusy(false));
        }}
      >
        {busy ? "Checking…" : "Check again"}
      </Button>
      {/* Several findings ("cwd '.' resolves to the project root", a server
          whose binary moved) have no remedy but editing the manifest, and the
          panel has no verb for that. Handing over the source of truth is the
          honest affordance — the manifest IS what agentstack renders from, so
          editing it here is the supported path, not a workaround. */}
      {onOpenManifest ? (
        <Button size="xs" variant="outline" onClick={onOpenManifest}>
          Open manifest
        </Button>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
        re-runs the same checks as <code className="font-mono">agentstack doctor</code>
      </span>
    </div>
  );
}

/**
 * Toolsets — what this project is working with, and the library it draws from,
 * in one tab.
 *
 * The library used to be a second dialog opened from inside the popover, which
 * meant "add a skill" started by leaving the screen that shows what you
 * already have. Here they are two views of one tab, so the answer to "do I
 * already have this?" is one click from the catalogue.
 */
function ToolsetsTab(props: ManageProps) {
  const [load, setLoad] = useState<LibLoad>({ phase: "loading" });
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<EditFlow>({ phase: "idle" });
  /** Non-null while composing a new toolset: its name and picked members. */
  const [draft, setDraft] = useState<{
    name: string;
    skills: ReadonlyArray<string>;
    servers: ReadonlyArray<string>;
  } | null>(null);
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);
  const [sessionDone, setSessionDone] = useState<{ ok: boolean; message: string } | null>(null);

  const loadIndex = props.loadLibraryIndex;
  const reload = useCallback(async () => {
    const r = await loadIndex();
    setLoad(r?.index ? { phase: "loaded", index: r.index } : { phase: "error" });
  }, [loadIndex]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const data = props.toolsets?.toolsets ?? null;
  const profiles = data?.profiles ?? [];
  const session = data?.session ?? null;
  const rows = useMemo(
    () => (data ? deriveToolsetRows(profiles, data.trust) : []),
    [data, profiles],
  );
  const index = load.phase === "loaded" ? load.index : null;

  const { previewProfileEdit, applyProfileEdit } = props;
  const beginEdit = useCallback(
    async (edit: AgentstackProfileEdit) => {
      const title = describeEdit(edit);
      setFlow({ phase: "previewing", edit, title });
      const result = await previewProfileEdit(edit);
      const digest = result?.preview?.consent_digest ?? null;
      setFlow(
        digest
          ? {
              phase: "confirm",
              edit,
              title,
              digest,
              note: result?.preview?.note ?? null,
              removal: result?.preview?.removal ?? null,
            }
          : { phase: "unsupported", title },
      );
    },
    [previewProfileEdit],
  );

  const confirmEdit = useCallback(async () => {
    if (flow.phase !== "confirm") return;
    const { edit, title, digest } = flow;
    setFlow({ phase: "running", edit, title });
    const r = await applyProfileEdit(edit, digest);
    setFlow({ phase: "done", ok: r.ok, message: r.message, title, edit });
    // A successful add/create changed the manifest; a ${REF}-blocked apply
    // wrote it too, so both re-read rather than leaving stale in-project flags.
    if (r.ok || matchSecretBlock(r.message)) {
      if (edit.kind === "create-profile") setDraft(null);
      await reload();
    }
  }, [flow, applyProfileEdit, reload]);

  const runSession = useCallback(
    async (key: string, act: () => Promise<{ ok: boolean; message: string }>) => {
      setSessionBusy(key);
      setSessionDone(null);
      const r = await act();
      setSessionBusy(null);
      setSessionDone(r);
    },
    [],
  );

  const toggleDraft = (group: "skill" | "server", name: string) =>
    setDraft((d) => {
      if (d === null) return d;
      const key = group === "skill" ? "skills" : "servers";
      const list = d[key];
      return {
        ...d,
        [key]: list.includes(name) ? list.filter((n) => n !== name) : [...list, name],
      };
    });

  return (
    // Two panes that never leave the screen. Choosing a tool used to mean
    // swapping the whole tab to a catalogue, then to a "which toolset?" screen,
    // then to a confirm screen — four different layouts for one decision, and
    // the toolsets you were deciding about were off-screen for three of them.
    // Now the toolsets stay on the left, the library stays on the right, and
    // every step of an edit happens where you already are.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <ToolsetRail
          rows={rows}
          profiles={profiles}
          session={session}
          canSessions={props.canSessions}
          sessionsKnownMissing={props.sessionsKnownMissing}
          canEditProfiles={props.canEditProfiles}
          busy={sessionBusy}
          done={sessionDone}
          draft={draft}
          onDraft={setDraft}
          onCreate={() => {
            if (draft) {
              void beginEdit({
                kind: "create-profile",
                name: draft.name,
                skills: [...draft.skills],
                servers: [...draft.servers],
              });
            }
          }}
          onStart={(name) => void runSession(name, () => props.onSessionStart(name))}
          onEnd={() => void runSession("__end__", props.onSessionEnd)}
        />
        {props.canEditProfiles ? (
          <LibraryPane
            load={load}
            index={index}
            query={query}
            onQuery={setQuery}
            profiles={profiles.map((p) => p.name)}
            draft={draft}
            onToggleDraft={toggleDraft}
            canRemove={props.canRemoveFromLibrary}
            busy={flow.phase !== "idle"}
            onAdd={(group, name, profile) =>
              void beginEdit(
                group === "skill"
                  ? { kind: "add-skill-to-profile", profile, name }
                  : { kind: "add-server-to-profile", profile, name },
              )
            }
            onRemove={(group, name) => void beginEdit({ kind: "remove-from-library", group, name })}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-start px-4 py-4">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              This agentstack CLI predates the library browser. Update it to add tools to a toolset
              from here.
            </p>
          </div>
        )}
      </div>
      {/* The consent step, anchored under the thing it is about rather than
          replacing it. You can still see which toolset you picked and what
          you picked it for while you decide. */}
      {flow.phase !== "idle" ? (
        // A pixel cap, not a percentage: a percentage max-height inside a flex
        // child resolves against a box whose own height is being negotiated,
        // which is how a confirm ends up either clipped or eating the panes
        // above it depending on how much text the CLI returned.
        <div className="max-h-[236px] shrink-0 overflow-y-auto border-t border-border/60 bg-foreground/[0.02]">
          <EditFlowCard
            flow={flow}
            createNeedsActivation={props.createNeedsActivation}
            // The activation the CLI stopped performing on create, offered in
            // the same reversible verb the rail uses. Null without
            // `sessions-v1`, where the card names the command instead of
            // offering a button that cannot work.
            onActivate={props.canSessions ? props.onSessionStart : null}
            onConfirm={confirmEdit}
            onBack={() => setFlow({ phase: "idle" })}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The left rail: every toolset this project declares, what it bundles, and the
 * verbs that change which one is in force. Always on screen — it is the thing
 * the library is being browsed *for*.
 */
function ToolsetRail({
  rows,
  profiles,
  session,
  canSessions,
  sessionsKnownMissing,
  canEditProfiles,
  busy,
  done,
  draft,
  onDraft,
  onCreate,
  onStart,
  onEnd,
}: {
  rows: ReadonlyArray<AgentstackToolsetRow>;
  profiles: ReadonlyArray<AgentstackToolset>;
  session: AgentstackActiveSession | null;
  canSessions: boolean;
  sessionsKnownMissing: boolean;
  canEditProfiles: boolean;
  busy: string | null;
  done: { ok: boolean; message: string } | null;
  draft: { name: string; skills: ReadonlyArray<string>; servers: ReadonlyArray<string> } | null;
  onDraft: (
    d: { name: string; skills: ReadonlyArray<string>; servers: ReadonlyArray<string> } | null,
  ) => void;
  onCreate: () => void;
  onStart: (name: string) => void;
  onEnd: () => void;
}) {
  const members = useMemo(() => new Map(profiles.map((p) => [p.name, p] as const)), [profiles]);
  const nameOk = draft !== null && PROFILE_NAME_INPUT_RE.test(draft.name);
  const picked = draft === null ? 0 : draft.skills.length + draft.servers.length;

  return (
    <div className="flex w-[264px] shrink-0 flex-col border-r border-border/60">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-3">
        <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
          TOOLSETS
        </span>
        {/* Hidden while the rail is empty: an empty column with a 10px "+ New"
            in its corner puts the only thing you can do here in the least
            prominent place on the tab. The empty state below carries it. */}
        {canEditProfiles && draft === null && rows.length > 0 ? (
          <button
            type="button"
            onClick={() => onDraft({ name: "", skills: [], servers: [] })}
            className="ml-auto shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground transition-colors hover:bg-accent"
          >
            + New
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* Composing a new toolset happens HERE, beside the library it draws
            from — the old form listed the whole library a second time, in its
            own screen, with its own checkboxes. */}
        {draft !== null ? (
          <div className="mb-2 flex flex-col gap-2 rounded-lg border border-success/35 bg-success/[0.06] p-2.5">
            <input
              value={draft.name}
              onChange={(e) => onDraft({ ...draft, name: e.target.value })}
              placeholder="Name it, e.g. web"
              spellCheck={false}
              autoFocus
              className="h-7 rounded-md border border-border/60 bg-background px-2 text-xs text-foreground outline-none focus:border-border"
            />
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              {picked === 0
                ? "Now click tools in the library to add them."
                : `${formatAgentstackCount(picked, "tool")} picked.`}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!nameOk || picked === 0}
                onClick={onCreate}
                className="inline-flex h-7 items-center rounded-md border border-success/40 bg-success/15 px-2.5 text-[11px] font-semibold text-success-foreground disabled:opacity-50"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => onDraft(null)}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
            {draft.name.length > 0 && !nameOk ? (
              <p className="text-[10.5px] text-warning-foreground">
                Letters, numbers, dot, dash or underscore — no spaces.
              </p>
            ) : null}
          </div>
        ) : null}

        {rows.length === 0 && draft === null ? (
          // A toolset has to exist before anything in the library can be added
          // to one — which is why every Add button on the right is disabled
          // right now. That's stated here, next to the button that fixes it,
          // rather than left for the user to infer from greyed-out controls.
          <div className="flex flex-col gap-2 rounded-lg border border-border/50 border-dashed px-2.5 py-3">
            <p className="text-[11.5px] font-semibold text-foreground">No toolsets yet</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A toolset bundles the servers and skills one kind of work needs. Nothing in the
              library can be added until there's one to add it to.
            </p>
            {canEditProfiles ? (
              <Button
                size="xs"
                variant="default"
                onClick={() => onDraft({ name: "", skills: [], servers: [] })}
                className="self-start font-semibold"
              >
                Create the first one
              </Button>
            ) : null}
          </div>
        ) : null}

        {rows.map((row) => {
          const profile = members.get(row.name);
          const inUse = row.active || session?.profile === row.name;
          return (
            <div
              key={row.name}
              className={cn(
                "mb-1.5 flex flex-col gap-1.5 rounded-lg border px-2.5 py-2",
                inUse ? "border-success/30 bg-success/[0.06]" : "border-border/50",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    inUse ? "bg-success" : row.ready ? "bg-success/60" : "bg-warning",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
                  {row.name}
                </span>
                {inUse && canSessions ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={onEnd}
                    className="shrink-0"
                  >
                    {busy === "__end__" ? "Stopping…" : "Stop"}
                  </Button>
                ) : row.ready && !session && canSessions ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => onStart(row.name)}
                    title="Use this toolset temporarily — ends with your files back as they were"
                    className="shrink-0"
                  >
                    {busy === row.name ? "Starting…" : "Use"}
                  </Button>
                ) : null}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {row.summary}
                {inUse && session ? ` · in use ${fmtAgo(session.started_unix)}` : ""}
              </span>
              {row.blockedBecause ? (
                <span className="text-[10.5px] leading-snug text-warning-foreground">
                  {row.blockedBecause}
                </span>
              ) : null}
              {profile && profile.servers.length + profile.skills.length > 0 ? (
                <p className="text-[10.5px] leading-relaxed text-muted-foreground/70">
                  {[...profile.servers, ...profile.skills].join(" · ")}
                </p>
              ) : null}
            </div>
          );
        })}

        {sessionsKnownMissing ? (
          <p className="px-1 pt-1 text-[10.5px] text-muted-foreground/70">
            Update agentstack to start a toolset from here.
          </p>
        ) : null}
        {done ? (
          <p
            className={cn(
              "px-1 pt-1 text-[11px]",
              done.ok ? "text-muted-foreground" : "text-destructive-foreground",
            )}
          >
            {done.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The right pane: the machine-wide library, with its filter pinned so it never
 * scrolls away from the list it filters.
 */
function LibraryPane({
  load,
  index,
  query,
  onQuery,
  profiles,
  draft,
  onToggleDraft,
  canRemove,
  busy,
  onAdd,
  onRemove,
}: {
  load: LibLoad;
  index: NonNullable<AgentstackLibraryIndexResult["index"]> | null;
  query: string;
  onQuery: (q: string) => void;
  /** Existing toolset names — the targets in each row's own Add menu. */
  profiles: ReadonlyArray<string>;
  draft: { name: string; skills: ReadonlyArray<string>; servers: ReadonlyArray<string> } | null;
  onToggleDraft: (group: "skill" | "server", name: string) => void;
  canRemove: boolean;
  /** An edit is mid-flight; the rows stop offering new ones. */
  busy: boolean;
  onAdd: (group: "skill" | "server", name: string, profile: string) => void;
  onRemove: (group: "skill" | "server", name: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        {/* The header carries the mode. A row's button reading "Add" means
            nothing on its own while a draft is open — add to WHAT? — so the
            target is named once, here, instead of encoded in a second verb on
            every row. */}
        {draft !== null ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-success/[0.12] px-2 py-0.5 text-[10.5px] font-semibold text-success-foreground">
            Adding to {draft.name.trim().length > 0 ? draft.name.trim() : "new toolset"}
          </span>
        ) : (
          <span className="shrink-0 text-[10.5px] font-semibold tracking-wide text-muted-foreground">
            LIBRARY
          </span>
        )}
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter skills and servers…"
          aria-label="Filter the library"
          className="h-7 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-2.5 text-[11px] text-foreground placeholder:text-muted-foreground/60"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {load.phase === "loading" ? (
          <p className="py-2 text-xs text-muted-foreground">Loading library…</p>
        ) : index === null ? (
          <p className="py-2 text-xs leading-relaxed text-muted-foreground">
            Couldn't read the library — <code className="font-mono">agentstack library-index</code>{" "}
            didn't return a catalog for this project.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <LibraryGroup
              title="Skills"
              group="skill"
              emptyLabel={
                query.trim().length > 0 ? "No skills match." : "No skills in the library yet."
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
              profiles={profiles}
              selected={draft?.skills ?? null}
              onToggleDraft={onToggleDraft}
              canRemove={canRemove}
              busy={busy}
              onAdd={onAdd}
              onRemove={onRemove}
            />
            <LibraryGroup
              title="Servers"
              group="server"
              emptyLabel={
                query.trim().length > 0 ? "No servers match." : "No servers in the library yet."
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
              profiles={profiles}
              selected={draft?.servers ?? null}
              onToggleDraft={onToggleDraft}
              canRemove={canRemove}
              busy={busy}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Activity — every brokered call and every workflow run, in one place.
 *
 * They were two navigation rows answering halves of the same question ("what
 * did my agents actually do, and did it work?"), one of which almost nobody
 * ever saw populated. One tab, calls first because they are the common case.
 */
function ActivityTab(props: ManageProps) {
  return (
    <div className="flex flex-col">
      <TabSection title="Brokered calls" first />
      <ActivityPanel activity={props.activity} />
      <TabSection title="Workflow runs" />
      <WorkflowPanel
        data={props.workflow}
        incompatible={props.workflowIncompatible}
        observeKnownMissing={props.workflowObserveKnownMissing}
        cliVersion={props.version ?? null}
        onOpenRun={props.onOpenRun}
      />
    </div>
  );
}

/**
 * The seam between two halves of a tab.
 *
 * A tab that stacks two panels reads as one long unlabelled scroll — you find
 * out you passed a boundary by noticing the content changed. One rule and one
 * label makes the boundary a fact instead of a surprise.
 */
function TabSection({ title, first = false }: { title: string; first?: boolean }) {
  return (
    <div className={cn("px-4 pb-1 pt-3", !first && "mt-1 border-t border-border/60")}>
      <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
        {title.toUpperCase()}
      </span>
    </div>
  );
}

/**
 * The small outline button an overview row or a finding hangs on its right.
 *
 * One definition rather than the four hand-rolled copies of the same 30-token
 * class string that had accumulated — the house rule is to reach for the
 * shared `Button`, and this is that button with the row's 10px scale pinned in
 * one place.
 */
function RowAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={onClick}
      className="mt-[2px] h-[22px] px-2 font-semibold text-[10px] sm:h-[22px] sm:text-[10px]"
    >
      {children}
    </Button>
  );
}

/**
 * The checkup's findings, below the rows.
 *
 * The Checkup row said "1 error · 7 warnings — each names its fix" and then
 * showed neither the findings nor the fixes: the panel already polls every line
 * and its remedy, and was rendering a number. Each finding shows its message
 * (bounded in the derivation — doctor lines carry repository-controlled names)
 * with the command doctor gave, and, where that command is one of the fixed
 * actions this panel exposes, a button that runs it through the same confirm
 * step as every other write.
 *
 * The command stays on screen even when the button is there: the button is an
 * extra affordance, never a replacement for saying what will run. It is
 * rendered muted, because it is the reference and the message is the news.
 *
 * One gate, not two. The disclosure stays closed — Toolset and Undo are two of
 * the four beginner ideas and a list opened by default pushes them out of the
 * 420px viewport — but opening it now shows the whole list for any ordinary
 * report, instead of three of five behind a second "See all".
 *
 * Exported for its own render test: "the findings are on screen with their
 * fixes, and a fix button appears only where the panel may honestly offer one"
 * is a claim about rendered output, so it is asserted on rendered output.
 */
export function CheckupFindings({
  findings,
  features,
  onRequestAction,
  onReviewDrift,
  defaultOpen = false,
  alreadyOffered = null,
}: {
  findings: ReadonlyArray<AgentstackFinding>;
  features: ReadonlyArray<string> | undefined;
  onRequestAction: (a: ActionKind) => void;
  /**
   * Start expanded. True in the Manage dialog, where the tab is 600px tall and
   * the findings are the reason you opened Setup — a disclosure there is a
   * click charged for hiding nothing. It stays closed anywhere the surface is
   * short enough that an open list would push other things off it.
   */
  defaultOpen?: boolean;
  /**
   * An action a sibling on the SAME screen already offers a button for.
   *
   * This list already refuses to offer one action twice within itself — four
   * providers missing the guard hook is one machine-wide write, not four
   * repairs. Putting the status summary and the findings in one tab
   * reintroduced exactly that from outside: "Enable guard" beside `Next`, and
   * "Enable guard" again on the finding four rows below. The finding still
   * shows its command; only the duplicate button goes.
   */
  alreadyOffered?: ActionKind | null;
  /**
   * Open the drift review from a Drift finding.
   *
   * Drift is the one finding class this list refuses to turn into a button
   * (adopt and apply differ, and the scope has to be chosen) — but refusing
   * the button left four rows printing a command with no way to act on it,
   * which is a list of homework, not a checkup. The review dialog IS the
   * honest way to act, so the row opens it. Omitted where no such surface
   * exists to open.
   */
  onReviewDrift?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const view = selectAgentstackFindingsView(findings, expanded, features);
  const { hidden, total } = view;
  const visible =
    alreadyOffered == null
      ? view.visible
      : view.visible.map((v) => (v.action === alreadyOffered ? { ...v, action: null } : v));
  if (total === 0) return null;
  return (
    // Indented to the rows' text column (px-2.5 + 6px dot + gap-2.5) and hung
    // off a rule, so it reads as the detail under the rows rather than as one
    // more, wider, sibling row.
    <details
      open={defaultOpen}
      className="group mr-1 mb-1 ml-[26px] border-border/50 border-l-2 py-1 pl-2.5 text-left"
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="text-xs font-semibold text-foreground">What the checkup found</span>
        <span className="text-[11px] text-muted-foreground">
          {formatAgentstackCount(total, "finding")}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/60 transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <ul className="flex flex-col pt-1.5">
        {visible.map(({ finding, action }) => (
          <li
            key={finding.key}
            className="flex items-start gap-2 border-border/40 border-t py-2 first:border-t-0 first:pt-0 last:pb-0"
          >
            <span
              className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", LEVEL_DOT[finding.level])}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground/70">{finding.section}</span>
              <span
                className={cn("wrap-break-word text-xs leading-snug", LEVEL_TEXT[finding.level])}
              >
                {finding.message}
              </span>
              {finding.fix !== null ? <CommandLine text={finding.fix} muted /> : null}
            </div>
            {action !== null ? (
              <RowAction onClick={() => onRequestAction(action)}>
                {ACTION_META[action].label}
              </RowAction>
            ) : finding.section === "Drift" && onReviewDrift ? (
              <RowAction onClick={onReviewDrift}>Review</RowAction>
            ) : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1.5 font-medium text-[11px] text-muted-foreground hover:text-foreground"
        >
          See all {total} →
        </button>
      ) : null}
    </details>
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
          <span className="shrink-0 text-xs font-semibold text-foreground">Next</span>
          <code className="min-w-0 wrap-break-word font-mono text-[11px] text-muted-foreground">
            {nextAction}
          </code>
          {runnable && onRunNextAction ? (
            // `accent` is a FILL token (white at 4% alpha in dark), so
            // `text-accent` rendered the panel's primary call to action at
            // ~1.05:1 against its own background — a ghost. The paired text
            // colour lives on the shared Button, which is the house rule
            // anyway: this is the one recommended step, so it gets the one
            // primary button on the panel.
            <Button
              size="xs"
              variant="default"
              onClick={() => onRunNextAction(runnable)}
              className="ml-auto h-[22px] font-semibold sm:h-[22px] sm:text-[11px]"
            >
              {ACTION_META[runnable].label}
            </Button>
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
  // The applied `edit` rides along into `done` because the outcome card is
  // per-verb: a finished `create-profile` has an activation step to offer, and
  // needs the toolset's name to offer it.
  | { phase: "done"; ok: boolean; message: string; title: string; edit: AgentstackProfileEdit };

/**
 * The container for a screen you *read* — a trust surface, a drift diff, the
 * library, the setup plan.
 *
 * These lived in the 400px status popover, which is the wrong shape for them:
 * a trust review lists every server, its exact command, every secret name and
 * skill, and it is the thing you study before granting authority. At 400px it
 * wrapped mid-path, truncated, and scrolled for pages. The workflow monitor
 * had already escaped to a dialog for exactly this reason; this generalises
 * that escape so the popover can go back to being a glance surface.
 *
 * Everything here also gets one navigation model: a title, a description, and
 * a close — instead of the mix of "← Back", panel takeovers and modals the
 * panel had grown.
 */
function PanelDialog({
  title,
  description,
  onClose,
  children,
  width = "max-w-2xl",
}: {
  title: string;
  description?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className={width}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 pr-8">
            <AgentstackMark className="size-[18px] shrink-0" />
            <span className="truncate">{title}</span>
          </DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto">{children}</div>
      </DialogPopup>
    </Dialog>
  );
}

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

/** Toolset-name input shape, mirrored from the server's PROFILE-name guard so
 *  the create button disables before a doomed round-trip. */
const PROFILE_NAME_INPUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface LibraryItem {
  name: string;
  origin: string;
  detail: string | null;
  inManifest: boolean;
}

/** One group (skills or servers) of the library pane. */
function LibraryGroup({
  title,
  group,
  emptyLabel,
  items,
  profiles,
  selected,
  onToggleDraft,
  canRemove,
  busy,
  onAdd,
  onRemove,
}: {
  title: string;
  group: "skill" | "server";
  emptyLabel: string;
  items: ReadonlyArray<LibraryItem>;
  profiles: ReadonlyArray<string>;
  /** Non-null while a new toolset is being composed: the picked members. */
  selected: ReadonlyArray<string> | null;
  onToggleDraft: (group: "skill" | "server", name: string) => void;
  canRemove: boolean;
  busy: boolean;
  onAdd: (group: "skill" | "server", name: string, profile: string) => void;
  onRemove: (group: "skill" | "server", name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold text-foreground">{title}</p>
      {items.length === 0 ? (
        <span className="text-[11px] text-muted-foreground/70">{emptyLabel}</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((it) => (
            <LibraryRow
              key={`${it.origin}:${it.name}`}
              item={it}
              group={group}
              profiles={profiles}
              picked={selected === null ? null : selected.includes(it.name)}
              onToggleDraft={onToggleDraft}
              canRemove={canRemove}
              busy={busy}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One library row.
 *
 * "Which toolset?" is answered inside the row. It used to be a whole screen:
 * click Add, the catalogue disappeared, a list of toolset names took its
 * place, and the confirm that followed asked the same question again in
 * different words. Now the row grows by one line, and the thing you asked
 * about never leaves the screen.
 *
 * Deliberately not a floating menu. This list lives inside a modal dialog, and
 * a portalled popover over a focus-trapped modal is a stack of assumptions
 * about z-order and outside-click that buys nothing here — one extra line, in
 * place, cannot land behind anything or steal the dialog's dismiss.
 */
function LibraryRow({
  item,
  group,
  profiles,
  picked,
  onToggleDraft,
  canRemove,
  busy,
  onAdd,
  onRemove,
}: {
  item: LibraryItem;
  group: "skill" | "server";
  profiles: ReadonlyArray<string>;
  picked: boolean | null;
  onToggleDraft: (group: "skill" | "server", name: string) => void;
  canRemove: boolean;
  busy: boolean;
  onAdd: (group: "skill" | "server", name: string, profile: string) => void;
  onRemove: (group: "skill" | "server", name: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const composing = picked !== null;
  // A toolset must exist before anything can be added to one, and composing a
  // new one takes over what every row's button means.
  const canChoose = !busy && profiles.length > 0;
  return (
    <div
      className={cn(
        "group flex flex-col rounded-lg px-1.5 py-[6px]",
        picked === true
          ? "bg-success/[0.08]"
          : choosing
            ? "bg-foreground/[0.04]"
            : "hover:bg-foreground/[0.03]",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            picked === true ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12px] font-semibold text-foreground">
            {item.name}
            {item.inManifest ? (
              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/60">
                in project
              </span>
            ) : null}
          </span>
          {item.detail ? (
            <span
              className="line-clamp-2 text-[10.5px] leading-snug text-muted-foreground"
              title={item.detail}
            >
              {item.detail}
            </span>
          ) : null}
        </div>

        {composing ? (
          // While composing, the same row IS the picker for the new toolset —
          // rather than a second copy of the whole library in its own form.
          //
          // Same verb as the normal state, deliberately. "Pick" here and "Add"
          // one mode over was two words for one gesture, and nothing on the row
          // said which mode it was in — so the button changed its label for
          // reasons the reader couldn't see. It is always "Add"; what changes
          // is what you are adding TO, which the header above now names.
          <Button
            size="xs"
            variant={picked ? "default" : "outline"}
            onClick={() => onToggleDraft(group, item.name)}
            className="shrink-0"
          >
            {picked ? "Added" : "Add"}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={!canChoose}
            onClick={() => setChoosing((c) => !c)}
            title={
              profiles.length === 0
                ? "Create a toolset first, then add tools to it"
                : "Add this to a toolset"
            }
            className="shrink-0"
          >
            {choosing ? "Cancel" : "Add"}
          </Button>
        )}

        {canRemove && !composing && !choosing && item.origin === "library" ? (
          // `Add` enrolls this capability in a toolset for THIS project;
          // `Remove` deletes it from the machine-wide library, for every
          // project. Two very different blast radii, so they do not sit side by
          // side as equals: the destructive one appears on row hover or
          // keyboard focus and carries destructive colour the moment it is
          // visible.
          <button
            type="button"
            disabled={busy}
            onClick={() => onRemove(group, item.name)}
            title="Remove from your library (all projects) — recoverable"
            aria-label={`Remove ${item.name} from your library`}
            className="shrink-0 rounded-md border border-transparent px-1.5 py-0.5 text-[10px] font-semibold text-destructive-foreground/80 opacity-0 transition-all hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
          >
            Remove
          </button>
        ) : null}
      </div>

      {choosing && !composing ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5 pl-3.5">
          <span className="text-[10.5px] text-muted-foreground">Add to</span>
          {profiles.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setChoosing(false);
                onAdd(group, item.name, p);
              }}
              className="rounded-md border border-border bg-background px-2 py-0.5 text-[10.5px] font-semibold text-foreground transition-colors hover:bg-accent"
            >
              {p}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The digest-confirm card for one library edit — the load-bearing consent step.
 * A preview without a digest disables the confirm (`unsupported`); the applied
 * result shows a plain success line, or — when an unresolved `${REF}` blocked
 * the render — a what/why/next-step card naming the exact `agentstack secret
 * set` command, never a bare red failure. A finished `create-profile` on a
 * `toolset-create-v2` CLI gets its own outcome card ([`CreatedToolsetCard`]),
 * because there the change is written but nothing is in use yet.
 *
 * Exported for its own render test: what this card CLAIMS happened is the whole
 * point of the H3 change, so it is asserted on rendered output.
 */
export function EditFlowCard({
  flow,
  createNeedsActivation,
  onActivate,
  onConfirm,
  onBack,
}: {
  flow: Exclude<EditFlow, { phase: "idle" }>;
  /** See [`LibraryPanel`]: true only when the CLI advertises `toolset-create-v2`. */
  createNeedsActivation: boolean;
  onActivate: ((profile: string) => Promise<{ ok: boolean; message: string }>) | null;
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
        <p className="text-[11px] leading-relaxed text-warning-foreground">
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
    // A created toolset is written but not in use — its own card, with the
    // activation step the CLI stopped performing. Only on a CLI that says so:
    // an older binary rendered on create, so the plain success line is right
    // there and an Activate button would be a second activation.
    if (flow.ok && flow.edit.kind === "create-profile" && createNeedsActivation) {
      return (
        <CreatedToolsetCard
          name={flow.edit.name}
          cliLine={flow.message}
          onActivate={onActivate}
          onBack={onBack}
        />
      );
    }
    const secretBlock = flow.ok ? null : matchSecretBlock(flow.message);
    return (
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[12.5px] font-semibold text-foreground">{flow.title}</p>
        {secretBlock ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-[11px] leading-relaxed">
            <span className="font-semibold text-warning-foreground">Set a secret to finish</span>
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
            <span
              className={cn(
                "font-semibold",
                flow.ok ? "text-success-foreground" : "text-destructive-foreground",
              )}
            >
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
  // Creating stops after the re-lock on a `toolset-create-v2` CLI, so the
  // render/`${REF}` clauses below would be false for it.
  const creatingOnly = flow.edit.kind === "create-profile" && createNeedsActivation;
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-[12.5px] font-semibold text-foreground">{flow.title}</p>
      {removing ? (
        <RemovalConfirmBody removal={removal} />
      ) : creatingOnly ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Applying writes the toolset and locks what it selects. Nothing is rendered — your CLIs
          keep the tools they have until you activate it — and nothing is written until you confirm.
        </p>
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
              ? "border-destructive/40 bg-destructive/10 text-destructive-foreground"
              : "border-success/40 bg-success/10 text-success-foreground",
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
 * The outcome of a successful `create-profile` on a CLI that advertises
 * `toolset-create-v2`: the toolset exists and is locked, and NOTHING was
 * rendered — no native config moved, so no CLI gained a tool. Saying "Done" and
 * dropping the user back into the library would leave them believing the
 * opposite, which is exactly the mis-affordance the CLI removed.
 *
 * So the card states what happened and offers the step the CLI stopped taking:
 * "Use temporarily", the same reversible session the Toolsets list offers, in
 * the same words. It is deliberately the session verb and not a permanent
 * render — activation is fail-closed in the CLI (a fresh toolset's new pins can
 * legitimately make the project's trust stale), and when it refuses, the CLI's
 * own line says why. Without `sessions-v1` there is no button, only the command.
 */
function CreatedToolsetCard({
  name,
  cliLine,
  onActivate,
  onBack,
}: {
  name: string;
  /** The CLI's own last line — quoted verbatim, as everywhere else in the panel. */
  cliLine: string;
  onActivate: ((profile: string) => Promise<{ ok: boolean; message: string }>) | null;
  onBack: () => void;
}) {
  const [act, setAct] = useState<
    { phase: "idle" } | { phase: "running" } | { phase: "done"; ok: boolean; message: string }
  >({ phase: "idle" });

  const activate = useCallback(async () => {
    if (onActivate === null) return;
    setAct({ phase: "running" });
    const r = await onActivate(name);
    setAct({ phase: "done", ok: r.ok, message: r.message });
  }, [onActivate, name]);

  // Once a session starts, "nothing was rendered" stops being true — the card
  // has to stop saying it rather than leave a stale claim on screen.
  const inUse = act.phase === "done" && act.ok;

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-[12.5px] font-semibold text-foreground">Toolset "{name}" created</p>
      <div className="flex flex-col gap-2 rounded-lg border border-success/30 bg-success/[0.06] px-3 py-2.5 text-[11px] leading-relaxed">
        <span className="font-semibold text-success">
          {inUse ? "In use" : "Written and locked"}
        </span>
        <span className="text-muted-foreground">
          {inUse
            ? "Started as a temporary session — end it from the Toolsets list and your files go back as they were."
            : "Nothing was rendered — your CLIs still have exactly the tools they had. Naming a toolset isn't switching to it; activating is a separate step."}
        </span>
        {cliLine ? (
          <span className="break-words font-mono text-muted-foreground/70">{cliLine}</span>
        ) : null}
      </div>

      {act.phase === "done" ? (
        <p
          className={cn(
            "text-[11px] leading-relaxed",
            act.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {act.message}
        </p>
      ) : null}

      {onActivate === null ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          This agentstack CLI predates session control from the panel — activate it in a terminal:
          <CommandLine text={`agentstack session start ${name}`} />
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {onActivate !== null && !inUse ? (
          <button
            type="button"
            disabled={act.phase === "running"}
            onClick={() => void activate()}
            title="Start a reversible session with this toolset — ends with your files back as they were"
            className="inline-flex h-8 items-center rounded-lg border border-success/40 bg-success/10 px-3.5 text-xs font-semibold text-success disabled:opacity-60"
          >
            {act.phase === "running" ? "Starting…" : "Use temporarily"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-muted-foreground"
        >
          ← Back to library
        </button>
      </div>
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
function CommandLine({
  text,
  muted = false,
}: {
  text: string;
  /**
   * Dim it. True where the command accompanies prose that is the actual news
   * (a checkup finding): at full brightness the argv is the loudest thing in
   * the row, and a list of them reads as a terminal transcript. False where
   * the command IS the instruction and nothing else on screen carries it.
   */
  muted?: boolean;
}) {
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
    <code
      className={cn(
        "mt-1 block font-mono text-[10.5px]",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
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
          <span className="font-semibold text-warning-foreground">This project uses it</span>
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
                className="inline-flex h-6 items-center rounded-md border border-warning/40 bg-warning/15 px-2.5 text-[11px] font-semibold text-warning-foreground disabled:opacity-60"
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
              <span
                className={cn(
                  "font-semibold",
                  act.ok ? "text-success-foreground" : "text-destructive-foreground",
                )}
              >
                {act.ok ? "Undone" : "Couldn't undo"}
              </span>
              {" — "}
              <span className="break-words font-mono text-muted-foreground">{act.message}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAct({ phase: "confirm" })}
              className="self-start text-[11px] font-semibold text-warning-foreground underline-offset-2 hover:underline"
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
      <p className="text-xs leading-relaxed text-muted-foreground">
        Setup reads the {plan.detected.length} coding{" "}
        {plan.detected.length === 1 ? "tool" : "tools"} on this machine and writes{" "}
        <span className="font-semibold text-foreground">one manifest</span> your CLIs render from.
        Nothing is written until you confirm.
      </p>

      {/* The ONE decision, first. It used to be the fifth thing on the screen,
          below three inventories — so the only choice setup asks you to make
          was the one you had to scroll to find, while the reference material
          led. Everything below this is inventory: collapsed, and true whether
          or not it is read. */}
      {plan.secrets.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-foreground">Where token values are stored</p>
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
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {reloading ? (
              "Updating the plan…"
            ) : (
              <>
                Values you'll still provide:{" "}
                {plan.secrets.map((s, i) => (
                  <Fragment key={s.reference}>
                    {i > 0 ? ", " : null}
                    <code className="font-mono text-foreground">{s.reference}</code>
                  </Fragment>
                ))}
              </>
            )}
          </p>
        </div>
      ) : null}

      <SetupGroup title="Coding tools found" count={{ n: plan.detected.length, noun: "tool" }}>
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

      {/* The summary counts BOTH kinds of import: this group lists imported
          settings too, so a servers-only count read "0 servers" on a plan that
          was importing every setting your tools had. */}
      <SetupGroup
        title="What will be imported"
        summary={formatAgentstackImportSummary({
          servers: plan.servers.length,
          settingsFrom,
        })}
      >
        {/* Same predicate the collapsed summary uses. Conflicts are not an
            import — they get their own block below — so counting them here made
            the summary say "nothing to import" while the body drew an empty
            list. */}
        {plan.servers.length === 0 && settingsFrom.length === 0 ? (
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
          </ul>
        )}
      </SetupGroup>

      {plan.conflicts.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-warning/30 bg-warning/8 px-2.5 py-2 dark:bg-warning/16">
          <p className="text-xs font-semibold text-warning-foreground">Defined more than once</p>
          <ul className="flex flex-col gap-0.5 text-xs leading-relaxed text-warning-foreground">
            {plan.conflicts.map((c) => (
              <li key={c.name}>
                <span className="font-semibold">{c.name}</span> is defined by{" "}
                {c.other_definitions + 1} tools — one will be used
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SetupGroup
        title="Files AgentStack will manage"
        count={{ n: (plan.destinations?.length ?? 0) + 1, noun: "file" }}
      >
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

      {setupUnsupported ? (
        <p className="text-[11px] leading-relaxed text-warning-foreground">
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
          <span
            className={cn(
              "font-semibold",
              act.ok ? "text-success-foreground" : "text-destructive-foreground",
            )}
          >
            {act.ok ? "Set up" : "Couldn't set up"}
          </span>
          {" — "}
          <span className="break-words font-mono text-muted-foreground">{act.message}</span>
        </div>
      ) : (
        // One write, one button, and the scope stated beside it. The second
        // screen this replaced restated the plan already on this page in
        // shorter words — a click that changes nothing you can see, between
        // you and the one you meant. The digest still binds: the CLI writes
        // nothing if detection moved since this plan was read.
        <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Writes{" "}
            <code className="font-mono text-foreground">
              {shortenAgentstackPath(plan.manifest_path, paths)}
            </code>{" "}
            only
            {plan.secrets.length > 0 && secretsChoice !== "skip"
              ? `, storing ${formatAgentstackCount(plan.secrets.length, "token value")} in ${
                  secretsChoice === "env" ? ".env" : "your system keychain"
                }`
              : ""}
            . Your CLIs' own configs aren't touched until you apply the setup to them.
          </p>
          <button
            type="button"
            disabled={!canSetUp || act.phase === "running"}
            onClick={() => void run()}
            className="inline-flex h-8 items-center self-start rounded-lg border border-success/40 bg-success/10 px-3.5 text-xs font-semibold text-success-foreground disabled:opacity-60"
          >
            {act.phase === "running" ? "Setting up…" : "Set up this project"}
          </button>
        </div>
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

/**
 * A labelled block inside a panel. `divided` draws a hairline above the label,
 * which is what separates stacked sections — without it a panel reads as one
 * continuous column of prose and the headings get lost in it. The
 * first section in a panel passes `divided={false}`.
 */
function PanelSection({
  title,
  children,
  divided = true,
}: {
  title: string;
  children: ReactNode;
  divided?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", divided && "border-t border-border/50 pt-3")}>
      <p className="text-xs font-semibold text-foreground">{title}</p>
      {children}
    </div>
  );
}

function SetupGroup({
  title,
  children,
  count,
  summary,
}: {
  title: string;
  children: ReactNode;
  /**
   * When given, the group collapses and this is what the summary reports.
   * The inventory lists are reference material — worth having, not worth
   * making someone scroll past to reach the button that does the work.
   */
  count?: { readonly n: number; readonly noun: string } | undefined;
  /**
   * The same thing for a group whose contents are not one countable noun —
   * a collapsed summary must never report one kind of item and silently omit
   * another. Wins over `count` when both are given.
   */
  summary?: string | undefined;
}) {
  const label = <span className="text-xs font-semibold text-foreground">{title}</span>;
  const collapsedSummary = summary ?? (count ? formatAgentstackCount(count.n, count.noun) : null);
  if (collapsedSummary === null) {
    return (
      <div className="flex flex-col gap-1">
        {label}
        {children}
      </div>
    );
  }
  return (
    <details className="group flex flex-col gap-1 border-t border-border/50 pt-2.5">
      <summary className="flex cursor-pointer select-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        {label}
        <span className="text-[11px] text-muted-foreground">{collapsedSummary}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60 transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="pt-1.5">{children}</div>
    </details>
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
        <span
          className={cn(
            "font-semibold",
            state.ok ? "text-success-foreground" : "text-destructive-foreground",
          )}
        >
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
          className="inline-flex h-6 items-center rounded-md border border-warning/40 bg-warning/15 px-2.5 text-[11px] font-semibold text-warning-foreground disabled:opacity-60"
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
                w.trusted
                  ? "bg-success/10 text-success-foreground"
                  : "bg-warning/10 text-warning-foreground",
              )}
            >
              {w.trusted ? "trusted" : "inert"}
            </span>
            <span
              className={cn(
                "inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10px] font-medium",
                w.lock_status === "matches"
                  ? "bg-muted-foreground/10 text-muted-foreground"
                  : "bg-destructive/10 text-destructive-foreground",
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
          ? { label: "resumable", className: "bg-warning/10 text-warning-foreground" }
          : r.outcome === "failed"
            ? { label: "failed", className: "bg-destructive/10 text-destructive-foreground" }
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
            <span className="inline-flex h-[17px] items-center rounded bg-success/10 px-1.5 text-[10px] font-semibold text-success-foreground">
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
                              <span className="max-w-44 shrink-0 truncate text-[10px] text-warning-foreground/90">
                                ⇠ {inputs}
                              </span>
                            ) : null}
                            <span className="inline-flex h-4 shrink-0 items-center rounded bg-warning/10 px-1.5 text-[10px] font-semibold text-warning-foreground">
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
                              <span className="truncate text-[10px] text-warning-foreground/90">
                                ⇠ {inputs}
                              </span>
                            ) : null}
                          </div>
                          <span className="inline-flex h-4 shrink-0 items-center rounded bg-warning/10 px-1.5 text-[10px] font-semibold text-warning-foreground">
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
                <span className="text-[11px] font-semibold text-warning-foreground">Resumable</span>
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
              <span className="font-semibold text-success-foreground">{counts.done} done</span>
              {counts.running > 0 ? (
                <>
                  {" · "}
                  <span className="font-semibold text-warning-foreground">
                    {counts.running} running
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
          {run?.exhausted ? (
            <span className="font-semibold text-warning-foreground">agent ceiling exhausted</span>
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
        <span className="ml-auto inline-flex h-[18px] items-center rounded bg-success/10 px-1.5 text-[10px] font-semibold text-success-foreground">
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
                    <span className="inline-flex h-4 shrink-0 items-center rounded bg-warning/10 px-1.5 text-[10px] font-semibold text-warning-foreground">
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
          <span className="font-semibold text-success-foreground">{counts.done} done</span> ·{" "}
          <span className="font-semibold text-warning-foreground">{counts.running} running</span>
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
              row.outcome === "denied" ? "text-warning-foreground" : "text-muted-foreground",
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
    <div className="flex flex-col gap-3 px-4 py-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        The manifest and <code className="font-mono">agentstack.lock</code> are the setup. Commit
        them and another machine reproduces it — each supplies its own secret values.
      </p>

      {/* The guarantee gets a surface of its own: it is the question people
          actually have, and it should not read as one more paragraph. */}
      <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-2">
        <p className="text-xs font-semibold text-foreground">What travels</p>
        <p className="text-xs leading-relaxed text-foreground/80">
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
          )}
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Secret values never enter the manifest, the lockfile, or this panel.
        </p>
      </div>

      <PanelSection title="Pin it first">
        {facts.pinning ? (
          <div className="flex items-start gap-2">
            <span
              className={cn("mt-1 size-1.5 shrink-0 rounded-full", LEVEL_DOT[facts.pinning.level])}
            />
            <span className="text-xs leading-relaxed text-foreground/80">{facts.pinning.msg}</span>
          </div>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          <code className="font-mono">lock</code> resolves every reference to exact bytes, so a
          teammate gets what you got — and a later change is visible instead of silent.
        </p>
        <CommandLine text="agentstack lock --write" />
      </PanelSection>

      <PanelSection title="Across your own machines">
        <p className="text-xs leading-relaxed text-muted-foreground">
          The central library travels as a git repo; server definitions keep their{" "}
          <code className="font-mono">{"${REF}"}</code> placeholders, so no secret leaves this
          machine.
        </p>
        <CommandLine text="agentstack lib sync" />
      </PanelSection>

      <PanelSection title="To a teammate">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Commit the manifest and lockfile. To let them verify the lockfile is yours, sign it and
          publish the printed public key; they verify before trusting.
        </p>
        <CommandLine text="agentstack sign" />
        <CommandLine text="agentstack verify --pubkey <key>" />
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          Moving a whole machine instead? <code className="font-mono">agentstack export</code>{" "}
          writes an encrypted bundle and <code className="font-mono">agentstack import</code> reads
          it — the one path that can carry secret values, behind a passphrase you type in a
          terminal.
        </p>
      </PanelSection>
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
              className="mt-0.5 shrink-0 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold text-warning-foreground transition-colors hover:bg-warning/20"
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
                  <span className="text-xs font-semibold text-foreground">{row.title}</span>
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
