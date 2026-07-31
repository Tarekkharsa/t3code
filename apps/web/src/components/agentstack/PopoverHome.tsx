/**
 * The popover's home surfaces beyond the one card: the readiness footer, the
 * inline toolset switch, and the delivery-mode chooser (panel wireframe v2 —
 * docs/design/panel-wireframe.md in the agentstack repo).
 *
 * Two deliberate asymmetries live here, and they are the design:
 *
 * - The TOOLSET list applies on click. A toolset switch is project-scope,
 *   reversible, and re-gates nothing, so two clicks is the honest cost.
 * - The MODE list never commits from the list. A mode switch is machine-scope
 *   and asymmetric (registering the bridge outlives switching back), so each
 *   option expands into the CLI's real transition plan and the confirm is a
 *   separate third click. Equal-looking controls teach equal safety — these
 *   two must not look or act alike.
 */
import { useCallback, useState } from "react";

import type {
  AgentstackProfileEdit,
  AgentstackProfileEditPreview,
  AgentstackProfileEditPreviewResult,
  AgentstackToolsetsResult,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  AGENTSTACK_MODE_OPTIONS,
  agentstackModeWord,
  classifyAgentstackEditPreview,
  deriveToolsetRows,
  formatAgentstackCount,
  matchAgentstackTrustRefusal,
  stripAgentstackErrorPrefix,
} from "./agentstack-logic";

/**
 * The footer: one readiness word, the delivery mode as a clickable word (not
 * a card — mode changes almost never, and a permanent card would re-clutter
 * the surface a previous pass cut from nine regions to one), the CLI count
 * scoped honestly to the mode, and the door to Manage.
 */
export function PopoverFooter({
  concern,
  modeLabel,
  onMode,
  clis,
  servedLive,
  onCoverage,
  onManage,
}: {
  /** True when the body shows a problem — the footer says so too. */
  concern: boolean;
  /** The doctor-reported mode, or null (older CLI / no project): say nothing. */
  modeLabel: string | null;
  /** Opens the mode chooser; null renders the word as plain text (no
   *  `set-mode-v1` — a clickable word the CLI can't honor is worse than none). */
  onMode: (() => void) | null;
  /** Machine CLI coverage (`doctor-cli-coverage-v1`), or null to omit. */
  clis: { capable: number; detected: number } | null;
  /** In live delivery the count is scoped: "N of M" and clickable, because a
   *  number that shrinks silently is worse than no number. */
  servedLive: boolean;
  onCoverage: () => void;
  onManage: () => void;
}) {
  const word = agentstackModeWord(modeLabel);
  const partial = servedLive && clis !== null && clis.capable < clis.detected;
  return (
    <div className="flex items-center gap-1.5 border-t border-border/60 px-4 py-2.5 text-[11.5px] text-muted-foreground">
      <span
        className={cn(
          "flex items-center gap-1.5 font-medium",
          concern ? "text-warning-foreground" : "text-success-foreground",
        )}
      >
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", concern ? "bg-warning" : "bg-success")}
        />
        {concern ? "Needs review" : "Ready"}
      </span>
      {word !== null ? (
        <>
          <span aria-hidden>·</span>
          {onMode !== null ? (
            <button
              type="button"
              onClick={onMode}
              title="How capabilities reach your CLIs — click to change"
              className="border-b border-dashed border-muted-foreground/50 leading-tight transition-colors hover:border-foreground hover:text-foreground"
            >
              {word}
            </button>
          ) : (
            <span>{word}</span>
          )}
        </>
      ) : null}
      {!concern && clis !== null ? (
        <>
          <span aria-hidden>·</span>
          {partial ? (
            <button
              type="button"
              onClick={onCoverage}
              title="Two delivery worlds: see which CLIs live delivery reaches"
              className="leading-tight transition-colors hover:text-foreground"
            >
              {clis.capable} of {formatAgentstackCount(clis.detected, "CLI")}
            </button>
          ) : (
            <span>{formatAgentstackCount(clis.detected, "CLI")}</span>
          )}
        </>
      ) : null}
      <button
        type="button"
        onClick={onManage}
        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        Manage
        <span aria-hidden>›</span>
      </button>
    </div>
  );
}

/**
 * The inline toolset switch: the daily verb, in the popover, two clicks total.
 * Picking a ready row applies it (the same temporary-session activation the
 * Manage rail offers) and closes; the Manage dialog never opens. Rows the
 * trust gate blocks say why and route to the review. Creation stays in Manage
 * — it needs the library beside it.
 */
export function InlineToolsetSwitch({
  toolsets,
  canSessions,
  onStart,
  onEnd,
  onReviewTrust,
  onManage,
  onDone,
  onBack,
}: {
  toolsets: AgentstackToolsetsResult | null;
  canSessions: boolean;
  onStart: (profile: string) => Promise<{ ok: boolean; message: string }>;
  onEnd: () => Promise<{ ok: boolean; message: string }>;
  onReviewTrust: () => void;
  onManage: () => void;
  /** A pick landed: the popover closes over the refreshed state. */
  onDone: () => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const data = toolsets?.toolsets ?? null;
  const session = data?.session ?? null;
  const rows = data ? deriveToolsetRows(data.profiles, data.trust) : [];
  const current = session?.profile ?? rows.find((r) => r.active)?.name ?? null;

  const pick = useCallback(
    async (name: string) => {
      setBusy(name);
      setFailed(null);
      // An open session is one-at-a-time: switching is end-then-start, the
      // same two commands a terminal user would run, as one gesture. A failed
      // end stops the gesture — the panel then shows the true state.
      let result = session !== null ? await onEnd() : { ok: true, message: "" };
      if (result.ok) result = await onStart(name);
      setBusy(null);
      if (result.ok) {
        onDone();
      } else {
        setFailed(result.message);
      }
    },
    [session, onEnd, onStart, onDone],
  );

  return (
    <div className="px-2.5 pb-2.5">
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2">
          <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
            SWITCH TO
          </span>
          <button
            type="button"
            onClick={onBack}
            className="ml-auto text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            ‹ Back
          </button>
        </div>
        {rows.map((row) => {
          const isCurrent = row.name === current;
          const pickable = canSessions && row.ready && !isCurrent && busy === null;
          return (
            <div
              key={row.name}
              role={pickable ? "button" : undefined}
              tabIndex={pickable ? 0 : undefined}
              onClick={pickable ? () => void pick(row.name) : undefined}
              onKeyDown={
                pickable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void pick(row.name);
                      }
                    }
                  : undefined
              }
              className={cn(
                "flex items-start gap-2 border-t border-border/40 px-3 py-2",
                isCurrent && "bg-success/[0.06]",
                pickable && "cursor-pointer transition-colors hover:bg-foreground/[0.04]",
              )}
            >
              {/* The dot is the apply-on-click marker — deliberately absent
                  from the mode chooser, which never commits from its list. */}
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-2 shrink-0 rounded-full border",
                  isCurrent ? "border-success bg-success" : "border-muted-foreground/50",
                )}
              />
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <span className="truncate">{row.name}</span>
                  {isCurrent ? (
                    <span className="rounded bg-foreground/[0.06] px-1 py-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                      current
                    </span>
                  ) : null}
                  {busy === row.name ? (
                    <span className="text-[10.5px] font-normal text-muted-foreground">
                      Switching…
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {row.summary}
                </span>
                {row.blockedBecause ? (
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] leading-snug text-warning-foreground">
                    {row.blockedBecause}
                    {row.blockedBecause.includes("review this project") ? (
                      <Button size="xs" variant="outline" onClick={onReviewTrust}>
                        Review this project
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onManage}
          className="flex w-full items-center gap-2 border-t border-border/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          + New toolset…
        </button>
        {failed !== null ? (
          <div className="flex flex-col items-start gap-1.5 border-t border-border/40 px-3 py-2">
            <p className="text-[11px] text-destructive-foreground">
              {matchAgentstackTrustRefusal(failed) ? stripAgentstackErrorPrefix(failed) : failed}
            </p>
            {matchAgentstackTrustRefusal(failed) ? (
              <Button size="xs" variant="outline" onClick={onReviewTrust}>
                Review this project
              </Button>
            ) : null}
          </div>
        ) : null}
        {!canSessions ? (
          <p className="border-t border-border/40 px-3 py-2 text-[10.5px] text-muted-foreground/70">
            Update agentstack to switch from here.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Per-option state of the mode chooser's expansion. */
type PlanState =
  | { phase: "loading" }
  | {
      phase: "plan";
      digest: string;
      preview: AgentstackProfileEditPreview;
    }
  | { phase: "refused"; message: string }
  | { phase: "unavailable" }
  | { phase: "unsupported" }
  | { phase: "applying" }
  | { phase: "failed"; message: string };

/**
 * The delivery-mode chooser. Clicking the footer word opens this list; each
 * option that isn't current expands into the CLI's real transition plan —
 * nothing commits from the list, and the confirm is the third click.
 */
export function ModeChooser({
  currentMode,
  previewEdit,
  applyEdit,
  onReviewTrust,
  onDone,
  onBack,
}: {
  currentMode: string | null;
  previewEdit: (edit: AgentstackProfileEdit) => Promise<AgentstackProfileEditPreviewResult | null>;
  applyEdit: (
    edit: AgentstackProfileEdit,
    digest: string,
  ) => Promise<{ ok: boolean; message: string }>;
  onReviewTrust: () => void;
  /** The switch landed: back to the resting card over refreshed state. */
  onDone: () => void;
  onBack: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);

  const expand = useCallback(
    async (mode: "static" | "clean-at-rest" | "zero-files") => {
      setExpanded(mode);
      setPlan({ phase: "loading" });
      const edit: AgentstackProfileEdit = { kind: "set-mode", mode };
      const outcome = classifyAgentstackEditPreview(await previewEdit(edit));
      setPlan(
        outcome.kind === "confirm"
          ? { phase: "plan", digest: outcome.digest, preview: outcome.preview }
          : outcome.kind === "refused"
            ? { phase: "refused", message: outcome.message }
            : outcome.kind === "unavailable"
              ? { phase: "unavailable" }
              : { phase: "unsupported" },
      );
    },
    [previewEdit],
  );

  const confirm = useCallback(
    async (mode: "static" | "clean-at-rest" | "zero-files", digest: string) => {
      setPlan({ phase: "applying" });
      const r = await applyEdit({ kind: "set-mode", mode }, digest);
      if (r.ok) {
        onDone();
      } else {
        setPlan({ phase: "failed", message: r.message });
      }
    },
    [applyEdit, onDone],
  );

  return (
    <div className="px-2.5 pb-2.5">
      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center gap-2 px-3 pb-1 pt-2">
          <span className="text-[10.5px] font-semibold tracking-wide text-muted-foreground">
            HOW CAPABILITIES REACH YOUR CLIS
          </span>
          <button
            type="button"
            onClick={onBack}
            className="ml-auto text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            ‹ Back
          </button>
        </div>
        {AGENTSTACK_MODE_OPTIONS.map((option) => {
          const isCurrent = option.mode === currentMode;
          const isExpanded = expanded === option.mode;
          return (
            <div key={option.mode} className="border-t border-border/40">
              <button
                type="button"
                disabled={isCurrent}
                onClick={() => {
                  if (isExpanded) {
                    setExpanded(null);
                    setPlan(null);
                  } else {
                    void expand(option.mode);
                  }
                }}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left",
                  isCurrent
                    ? "cursor-default bg-success/[0.06]"
                    : "transition-colors hover:bg-foreground/[0.04]",
                )}
              >
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    {option.title}
                    {isCurrent ? (
                      <span className="rounded bg-foreground/[0.06] px-1 py-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                        current
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[11px] leading-relaxed text-muted-foreground">
                    {option.desc}
                  </span>
                </div>
                {!isCurrent ? (
                  <span aria-hidden className="mt-0.5 text-[10px] text-muted-foreground">
                    {isExpanded ? "▴" : "▾"}
                  </span>
                ) : null}
              </button>
              {isExpanded && plan !== null ? (
                <ModePlan
                  option={option}
                  plan={plan}
                  onConfirm={(digest) => void confirm(option.mode, digest)}
                  onCancel={() => {
                    setExpanded(null);
                    setPlan(null);
                  }}
                  onReviewTrust={onReviewTrust}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One row of the transition plan. */
function PlanRow({
  sym,
  tone,
  children,
}: {
  sym: string;
  tone: "remove" | "add" | "warn" | "note";
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-1.5 py-0.5 text-[11px] leading-snug text-foreground">
      <span
        aria-hidden
        className={cn(
          "w-3 shrink-0 text-center font-semibold",
          tone === "remove" && "text-destructive-foreground",
          tone === "add" && "text-success-foreground",
          tone === "warn" && "text-warning-foreground",
          tone === "note" && "text-muted-foreground",
        )}
      >
        {sym}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * The expanded plan: exactly what the CLI's preview says this switch would do,
 * in both directions, including who stops being served — then the confirm.
 * When the CLI names a blocker, the confirm is replaced by the honest next
 * step (the trust review, ending the session) instead of a button that would
 * only relay a refusal. Exported for the rendered-output tests — the claims
 * here ("the plan names the two CLIs that fall out", "no confirm on a
 * blocker") are claims about markup.
 */
export function ModePlan({
  option,
  plan,
  onConfirm,
  onCancel,
  onReviewTrust,
}: {
  option: { mode: string; title: string };
  plan: PlanState;
  onConfirm: (digest: string) => void;
  onCancel: () => void;
  onReviewTrust: () => void;
}) {
  if (plan.phase === "loading") {
    return <p className="px-3 pb-2 text-[11px] text-muted-foreground">Working out the plan…</p>;
  }
  if (plan.phase === "applying") {
    return <p className="px-3 pb-2 text-[11px] text-muted-foreground">Switching…</p>;
  }
  if (plan.phase === "refused" || plan.phase === "failed") {
    return (
      <p className="px-3 pb-2 text-[11px] text-destructive-foreground">
        {stripAgentstackErrorPrefix(plan.message)}
      </p>
    );
  }
  if (plan.phase === "unavailable") {
    return (
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">
        Couldn't read the plan — try again.
      </p>
    );
  }
  if (plan.phase === "unsupported") {
    return (
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">
        This agentstack can't switch modes from here — update it, or run{" "}
        <code className="rounded bg-foreground/[0.06] px-1 font-mono text-[10px]">
          agentstack set-mode {option.mode}
        </code>{" "}
        in a terminal.
      </p>
    );
  }

  const p = plan.preview;
  const bridge = p.bridge ?? null;
  const blocker = p.mode_blocker ?? p.render_blocker ?? null;
  const sessionHeld = p.session_active ?? null;
  const needsTrust = p.requires_trust === true;
  const confirmable = !needsTrust && blocker === null && sessionHeld === null;

  return (
    <div className="mx-3 mb-2 overflow-hidden rounded-md border border-border/60 bg-foreground/[0.02]">
      <p className="px-2.5 pb-0.5 pt-1.5 text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">
        What this would do
      </p>
      <ul className="px-2.5 pb-1.5">
        {(p.removes ?? []).map((r) => (
          <PlanRow key={`${r.label}:${r.path}`} sym="−" tone="remove">
            remove {r.label} <span className="text-muted-foreground">{r.path}</span>
          </PlanRow>
        ))}
        {p.removes_gitignore_block === true ? (
          <PlanRow sym="−" tone="remove">
            remove the managed .gitignore block
          </PlanRow>
        ) : null}
        {p.locks === true ? (
          <PlanRow sym="+" tone="add">
            pin agentstack.lock — sessions activate from it
          </PlanRow>
        ) : null}
        {p.renders != null ? (
          <PlanRow sym="+" tone="add">
            render configs for <span className="font-semibold">{p.renders.profile}</span> into your
            CLIs
          </PlanRow>
        ) : null}
        {bridge !== null && bridge.registers ? (
          <PlanRow sym="+" tone="add">
            register the bridge in your CLI configs —{" "}
            <span className="font-semibold">
              {bridge.capable} of {bridge.detected} CLIs
            </span>{" "}
            can host it
          </PlanRow>
        ) : null}
        {bridge !== null && !bridge.registers ? (
          <PlanRow sym="·" tone="note">
            the bridge is already registered on this machine
          </PlanRow>
        ) : null}
        {bridge !== null && bridge.incapable.length > 0 ? (
          <PlanRow sym="!" tone="warn">
            <span className="font-semibold">
              {formatAgentstackCount(bridge.incapable.length, "CLI")} can't consume live delivery
            </span>{" "}
            — {bridge.incapable.join(", ")} would get nothing here
          </PlanRow>
        ) : null}
        {p.removes_instructions === true ? (
          <PlanRow sym="!" tone="warn">
            compiled CLAUDE.md / AGENTS.md instructions are not delivered live
          </PlanRow>
        ) : null}
        {p.undo !== undefined ? (
          <PlanRow sym="↺" tone="note">
            undo:{" "}
            <code className="rounded bg-foreground/[0.06] px-1 font-mono text-[10px]">
              {p.undo}
            </code>
          </PlanRow>
        ) : null}
      </ul>
      {p.machine_scope === true ? (
        <div className="border-t border-border/60 bg-warning/[0.08] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-foreground">
          <span className="font-semibold">Machine-wide.</span> Registering the bridge changes every
          CLI's config on this machine, not just this project. Switching this project back later
          does not unregister it.
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-2.5 py-2">
        {confirmable ? (
          <>
            <Button
              size="xs"
              variant="default"
              className="font-semibold"
              onClick={() => onConfirm(plan.digest)}
            >
              Switch to {option.title.toLowerCase()}
            </Button>
            <Button size="xs" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : needsTrust ? (
          <>
            <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-warning-foreground">
              Unreviewed content stays inert, so live delivery would serve nothing yet.
            </span>
            <Button size="xs" variant="default" className="font-semibold" onClick={onReviewTrust}>
              Review this project first
            </Button>
          </>
        ) : sessionHeld !== null ? (
          <span className="text-[10.5px] leading-snug text-warning-foreground">
            "{sessionHeld}" is in use here — stop using it first, then switch modes.
          </span>
        ) : (
          <span className="text-[10.5px] leading-snug text-warning-foreground">{blocker}</span>
        )}
      </div>
    </div>
  );
}
