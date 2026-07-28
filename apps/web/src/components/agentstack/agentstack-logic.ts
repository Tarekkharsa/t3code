/**
 * Pure logic for the AgentStack panel: mapping `agentstack doctor --json`
 * output into compact overview rows, and recognizing AgentStack guard
 * denials in work-log entries so the timeline can render them as a card.
 *
 * AgentStack is an external local CLI; its output is treated as untrusted
 * input throughout — every function here degrades to "no data" rather than
 * throwing on unexpected shapes.
 */

export interface AgentstackDoctorLine {
  level: string;
  msg: string;
}

export interface AgentstackDoctorSection {
  title: string;
  lines: ReadonlyArray<AgentstackDoctorLine>;
}

/** Cooperative host protections (guard + machine policy) — NOT a sandbox. */
export interface AgentstackProtection {
  guard: boolean;
  machine_policy: boolean;
}

export interface AgentstackDoctorReport {
  errors: number;
  warnings: number;
  /**
   * Findings that are true and worth stating but are NOT something this
   * project must repair — the CLI excludes them from `warnings`, `state`, and
   * `next_action`. Absent on binaries predating `doctor-advisories-v1`, so
   * gate the display on that feature rather than on this field being defined.
   */
  advisories?: number | null;
  /** trusted | drifted | untrusted, when the CLI emits it (else undefined). */
  trust?: string | null;
  /** needs_setup | needs_attention | ready, when the CLI emits it. */
  state?: string | null;
  /** One recommended command, or null/absent when nothing is pending. */
  next_action?: string | null;
  /** The cooperative host-protection posture, when reported. */
  protection?: AgentstackProtection | null;
  sections: ReadonlyArray<AgentstackDoctorSection>;
}

/** `muted` = a grey "not a fault, just a fact" dot (e.g. an available capability). */
export type AgentstackRowLevel = "ok" | "warn" | "error" | "muted";

export interface AgentstackOverviewRow {
  key: string;
  label: string;
  summary: string;
  level: AgentstackRowLevel;
  /** A vetted governed action this row can trigger directly (e.g. enable guard). */
  action?: AgentstackActionKind;
  /**
   * True on the Manifest row when drift exists: the button opens the drift
   * review (which previews `diff --json` and lets the user pick adopt vs apply
   * at the right scope) rather than firing a single fixed action. Drift is
   * never fixed by one blind click, because the safe verb (adopt) and the
   * re-render verb (apply) differ and the scope must be chosen.
   */
  reviewDrift?: boolean;
  /**
   * What this row contributes to the single reassurance line, phrased as the
   * outcome the user came for ("3 CLIs in sync").
   *
   * Set HERE, where the facts that justify the claim are in hand, and only
   * when they do justify it. It is deliberately NOT re-derived from `summary`
   * downstream: a summary is display text — truncated to fit a row, joined
   * from independent facts, reworded between doctor versions — so reading a
   * claim back out of one is exactly how a reassurance line ends up asserting
   * something the report never said.
   *
   * Absent means "no specific claim available": the line falls back to naming
   * the row ("library ok"), which is only ever as strong as the row's own `ok`
   * level. Explicit `null` means "fine, and there is nothing worth saying" —
   * the row drops out of the line entirely.
   */
  healthy?: string | null;
}

/**
 * The vetted, server-enumerated CLI actions the panel may trigger. Mirrors the
 * closed `AgentstackActionKind` enum in the contracts package; the server maps
 * each to fixed argv (scope included) and never passes `--prune-foreign`.
 */
export type AgentstackActionKind =
  | "apply-project"
  | "apply-global"
  | "adopt-project"
  | "adopt-global"
  | "guard-install";

function sectionByTitle(
  report: AgentstackDoctorReport,
  title: string,
): AgentstackDoctorSection | undefined {
  return report.sections.find((s) => s.title === title);
}

function worstLevel(section: AgentstackDoctorSection): AgentstackRowLevel {
  if (section.lines.some((l) => l.level === "error")) return "error";
  if (section.lines.some((l) => l.level === "warn")) return "warn";
  return "ok";
}

function lineContaining(
  section: AgentstackDoctorSection | undefined,
  needle: string,
): AgentstackDoctorLine | undefined {
  return section?.lines.find((l) => l.msg.toLowerCase().includes(needle));
}

/**
 * `1 error` / `2 errors` — a count and its noun, pluralized properly.
 *
 * Exported because the panel renders counts too ("3 findings", "1 server"),
 * and a second pluralizer written inline in a render is a second thing to get
 * wrong and nothing to test it with.
 */
export function formatAgentstackCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const countOf = formatAgentstackCount;

/**
 * The Checkup row's summary: what the checkup found, in words a human wrote.
 *
 * It used to read "1 error(s) · 7 warning(s)" — the parenthetical plural is a
 * programmer's shorthand for "I didn't want to branch", and it is the first
 * line of the panel's most important row.
 */
export function formatAgentstackCheckupSummary(errors: number, warnings: number): string {
  if (errors <= 0 && warnings <= 0) return "all checks pass";
  const parts = [
    errors > 0 ? countOf(errors, "error") : null,
    warnings > 0 ? countOf(warnings, "warning") : null,
  ].filter((p): p is string => p !== null);
  return `${parts.join(" · ")} — each names its fix`;
}

/**
 * Curated mapping from real doctor sections to the design's overview rows.
 * Each row is sourced from actual doctor output — rows we cannot source
 * honestly are omitted rather than filled with invented numbers, so the panel
 * stays truthful across agentstack versions.
 *
 * Beginner surface only (Stage 1.4): the overview names outcomes — is the
 * setup in sync, does the checkup pass, do secrets resolve, is the library
 * pinned. Guard/gateway/sandbox/workflow facts move to the protection and
 * advanced views (`deriveAgentstackProtectionRows`), so first-run navigation
 * stays Setup / Toolset / Status / Undo.
 */
export function deriveAgentstackOverviewRows(
  report: AgentstackDoctorReport,
): AgentstackOverviewRow[] {
  const rows: AgentstackOverviewRow[] = [];

  // Manifest ← Drift section. Two distinct kinds of non-ok line exist and must
  // not be conflated (doing so is what made the old "Fix drift" button a no-op):
  //   • warn/error — a re-render would actually rewrite this project's config
  //     (a real, own-manifest hand-edit or pending change) → actionable.
  //   • info — servers another setup applied are *kept* on disk; a default
  //     apply never removes them, so this is a fact to surface, not drift to
  //     "fix". Firing `apply` at it writes nothing.
  // Either kind opens the drift review (which runs `diff --json` to show the
  // exact change and offers adopt vs apply at the right scope); we never wire a
  // one-click fixed action here.
  const drift = sectionByTitle(report, "Drift");
  if (drift) {
    const actionable = drift.lines.some((l) => l.level === "warn" || l.level === "error");
    const foreignKept = !actionable && drift.lines.some((l) => l.level === "info");
    const cliCount = sectionByTitle(report, "Adapters & CLIs")?.lines.filter(
      (l) => l.level === "ok",
    ).length;
    // Doctor's own words for "drift was CHECKED and every target matched". It
    // is the ONLY line that licenses a sync claim, and the check must be for
    // that line rather than for the absence of warnings: clean-at-rest mode
    // skips the comparison entirely and says so with an `ok` line of its own
    // ("not rendering configs — clean-at-rest keeps them off disk"), which
    // leaves the section warning-free precisely because nothing was rendered
    // or compared. Claiming "3 CLIs in sync" there would reassure the user
    // about a render they deliberately turned off. Matching the positive
    // phrase fails safe: a doctor that reworded it makes us claim less.
    const allInSync = drift.lines.some(
      (l) => l.level === "ok" && l.msg.trim().startsWith("all targets in sync"),
    );
    rows.push({
      key: "manifest",
      label: "Manifest",
      summary: actionable
        ? "changes pending on disk"
        : foreignKept
          ? "in sync here · other setups' servers kept"
          : `in sync${cliCount ? ` · rendered to ${cliCount} CLIs` : ""}`,
      // `info`-only drift is not a fault (this project renders cleanly), so it
      // stays an "ok" dot; only real own-manifest drift warns.
      level: actionable ? "warn" : "ok",
      ...(actionable || foreignKept ? { reviewDrift: true as const } : {}),
      // Cross-CLI convergence is what the product promises, so it is what the
      // reassurance line should say — but only over CLIs doctor actually
      // compared. The count is of installed adapters whose config parses, all
      // of which are render targets, and `allInSync` covers every target.
      ...(allInSync && cliCount ? { healthy: `${countOf(cliCount, "CLI")} in sync` } : {}),
    });
  }

  // "Checkup", not "doctor": the beginner label for the same fact (the key
  // stays `doctor` — it names the source, not the display).
  rows.push({
    key: "doctor",
    label: "Checkup",
    summary: formatAgentstackCheckupSummary(report.errors, report.warnings),
    level: report.errors > 0 ? "error" : report.warnings > 0 ? "warn" : "ok",
  });

  const secrets = sectionByTitle(report, "Secrets");
  if (secrets) {
    // Doctor writes one `NAME  resolved from <layer>` line per ref, and the
    // single line "no secrets referenced" when there are none. Read off the
    // whole section, not off `summary` — which is one line of it, clipped to
    // row width, so a long enough ref name pushes "resolved from" out of view.
    const anyResolved = secrets.lines.some((l) => l.msg.includes("resolved from"));
    rows.push({
      key: "secrets",
      label: "Secrets",
      summary: firstMessage(secrets) ?? "—",
      level: worstLevel(secrets),
      healthy: anyResolved ? "secrets resolved" : "no secrets needed",
    });
  }

  // Library ← Skills section (the manifest's library-backed capabilities).
  const skills = sectionByTitle(report, "Skills");
  if (skills) {
    // "no skills defined" is a healthy nothing: there is no reassurance in it,
    // so the row says nothing on the reassurance line rather than padding it.
    const anyInstalled = skills.lines.some((l) => l.level === "ok" && l.msg.includes("present"));
    rows.push({
      key: "library",
      label: "Library",
      summary: firstMessage(skills) ?? "—",
      level: worstLevel(skills),
      healthy: anyInstalled ? "skills installed" : null,
    });
  }

  return rows;
}

// ── "More protection" ladder ─────────────────────────────────────────────────

export interface AgentstackProtectionRow {
  key: string;
  label: string;
  /** What this layer covers, honestly — no claim beyond the enforcement. */
  summary: string;
  /** What turning it on costs (setup, dependencies, speed), when it isn't free. */
  cost?: string;
  level: AgentstackRowLevel;
  /** A vetted governed action this row can trigger directly (enable guard). */
  action?: AgentstackActionKind;
}

/**
 * The "More protection" view: every stronger mode in one place, each labelled
 * with what it actually covers and what it costs (Stage 1.4). The first two
 * rows read live state from doctor sections; the run tiers are standing
 * capabilities of the binary, described but never claimed as active.
 */
export function deriveAgentstackProtectionRows(
  report: AgentstackDoctorReport,
): AgentstackProtectionRow[] {
  const rows: AgentstackProtectionRow[] = [];

  // Guard ← the t3code supervisor section's guard line (present wherever this
  // panel runs). Offer "enable guard" when it isn't covering the providers.
  const t3 = sectionByTitle(report, "t3code (supervisor)");
  const guardLine = lineContaining(t3, "guard");
  if (guardLine) {
    const enabled = guardLine.level === "ok";
    rows.push({
      key: "guard",
      label: "Guard",
      summary: enabled
        ? "on — blocks destructive agent commands before they run"
        : "off — agent commands run without a pre-check",
      cost: enabled
        ? "covers agent tool calls on this machine — not a sandbox"
        : "free — adds a pre-check hook to every detected CLI",
      level: enabled ? "ok" : "warn",
      ...(enabled ? {} : { action: "guard-install" as const }),
    });
  }

  // Machine policy ← the always-computed one-word posture. "unconfigured" is
  // a fact, not a fault — muted, with the exact place to add one.
  const machine = sectionByTitle(report, "Machine policy");
  const machineMsg = machine ? (firstMessage(machine) ?? "") : "";
  if (machine) {
    const unconfigured = machineMsg.startsWith("unconfigured");
    rows.push({
      key: "machine-policy",
      label: "Machine policy",
      summary: unconfigured
        ? "none — each project uses its own limits"
        : `the ceiling every session runs under — ${machineMsg}`,
      cost: unconfigured
        ? "add [policy] to ~/.agentstack/agentstack.toml — no repo can loosen it"
        : "no repo or UI can loosen it",
      level: unconfigured ? "muted" : worstLevel(machine),
    });
  }

  // Zero-files gateway ← live registration state; honest about what inertness
  // means (review-gated serving), not an enforcement claim about rendered files.
  const gateway = sectionByTitle(report, "Zero-files gateway");
  if (gateway) {
    const registered = gateway.lines.filter(
      (l) => l.level === "ok" && l.msg.includes("gateway registered"),
    ).length;
    rows.push({
      key: "gateway",
      label: "Live serving",
      summary:
        registered > 0
          ? `on — ${registered} CLI(s) fetch servers live; unreviewed repos stay inert`
          : "off — servers render as config files instead",
      cost: "review each repo once before its servers run",
      level: registered > 0 ? worstLevel(gateway) : "muted",
    });
  }

  // Standing run tiers — capabilities of the binary, never claimed active.
  rows.push({
    key: "locked-run",
    label: "Locked run",
    summary: "agentstack run <cli> --locked — pins content and records evidence",
    cost: "host process — not kernel isolation",
    level: "muted",
  });
  rows.push({
    key: "sandbox",
    label: "Sandbox",
    summary:
      "agentstack run --sandbox / --lockdown — container isolation; lockdown enforces the network route",
    cost: "needs Docker · slower start",
    level: "muted",
  });

  return rows;
}

// ── trust badge (header) ─────────────────────────────────────────────────────

export type AgentstackTrustState = "trusted" | "inert" | "drifted" | "unknown";

export interface AgentstackTrustBadge {
  state: AgentstackTrustState;
  label: string;
}

/**
 * The header trust badge. Derived from the gateway section's auto-mode line:
 * "trusted for auto mode" → trusted, "not trusted" → inert (untrusted repos
 * are inert until reviewed). Drift that has re-gated trust shows `drifted`.
 * Distinguishing drifted from inert precisely needs a structured trust state
 * agentstack does not yet emit, so we only claim `drifted` on a clear signal.
 */
export function deriveAgentstackTrustBadge(report: AgentstackDoctorReport): AgentstackTrustBadge {
  // Prefer the CLI's structured trust state when present — it's authoritative
  // and distinguishes drifted from untrusted, which prose can't reliably do.
  switch (report.trust) {
    case "trusted":
      return { state: "trusted", label: "Repo trusted" };
    case "drifted":
      return { state: "drifted", label: "Drift — re-gated" };
    case "untrusted":
      return { state: "inert", label: "Inert — review pending" };
  }
  // Fallback for older CLIs: infer from the gateway section's prose.
  const gateway = sectionByTitle(report, "Zero-files gateway");
  // "not trusted for auto mode" contains "trusted for auto mode" — test the
  // negative first.
  const notTrusted = gateway?.lines.some((l) => l.msg.includes("not trusted"));
  const trusted =
    !notTrusted && gateway?.lines.some((l) => l.msg.includes("trusted for auto mode"));
  const reGated = report.sections.some((s) =>
    s.lines.some((l) => l.level !== "ok" && /re-?gat|re-?trust/i.test(l.msg)),
  );
  if (reGated) return { state: "drifted", label: "Drift — re-gated" };
  if (trusted) return { state: "trusted", label: "Repo trusted" };
  if (notTrusted) return { state: "inert", label: "Inert — review pending" };
  return { state: "unknown", label: "Status unknown" };
}

// ── status chip (header) ─────────────────────────────────────────────────────

export type AgentstackSetupState = "needs_setup" | "needs_attention" | "ready";

export interface AgentstackStatusChip {
  /** "Needs setup" | "Needs attention" | "Ready" | "Protected". */
  label: string;
  level: AgentstackRowLevel;
  /** True only for the "Protected" chip (ready + both cooperative protections). */
  isProtected: boolean;
}

/**
 * Derive the single status chip from the doctor's structured `state`. "Protected"
 * is a strictly stronger "Ready": it appears only when the project is ready AND
 * both cooperative host protections (the pre-tool-use guard and a machine policy
 * ceiling) are on. It is deliberately NOT a claim of sandboxing. When `state` is
 * absent (older CLI) the chip is null and the caller falls back to the row
 * rollup.
 */
export function deriveAgentstackStatusChip(input: {
  state?: string | null | undefined;
  protection?: AgentstackProtection | null | undefined;
}): AgentstackStatusChip | null {
  switch (input.state) {
    case "needs_setup":
      return { label: "Needs setup", level: "warn", isProtected: false };
    case "needs_attention":
      return { label: "Needs attention", level: "warn", isProtected: false };
    case "ready": {
      const isProtected =
        input.protection?.guard === true && input.protection?.machine_policy === true;
      return isProtected
        ? { label: "Protected", level: "ok", isProtected: true }
        : { label: "Ready", level: "ok", isProtected: false };
    }
    default:
      return null;
  }
}

// ── capability negotiation & feature gating ──────────────────────────────────

export interface AgentstackIncompatible {
  /** The CLI payload's schema_version. */
  cliSchema: number;
  /** The schema this t3code build supports. */
  supported: number;
}

/**
 * Whether a named end-to-end contract is usable against the connected CLI.
 * `features` is the negotiated list a read returned (server defaults an absent
 * envelope to `[]`). An unknown/absent list means the contract is NOT usable —
 * these are newer-CLI-only actions, so the safe default is "disabled, update
 * the CLI", never "fire and hope".
 */
export function hasAgentstackFeature(
  features: ReadonlyArray<string> | undefined,
  feature: string,
): boolean {
  return (features ?? []).includes(feature);
}

/**
 * True only when we positively KNOW the feature is unavailable — the features
 * list is non-empty (so the CLI advertised its contracts) and does not name it.
 * Used to add an extra gate to trust-grant only when features are known, while
 * leaving the existing digest-presence gate to stand on its own for older CLIs
 * (empty/unknown features), which never advertise the list.
 */
export function agentstackFeatureKnownMissing(
  features: ReadonlyArray<string> | undefined,
  feature: string,
): boolean {
  return Array.isArray(features) && features.length > 0 && !features.includes(feature);
}

// ── undo (restore ledger) ────────────────────────────────────────────────────

export interface AgentstackRestoreEntryLike {
  id: string;
  short_id?: string;
  time_unix: number;
  scope: string;
  summary: string;
  undone: boolean;
  /** True when this entry's files live under the current workspace. */
  touches_project: boolean;
}

/**
 * The entry the panel's "Undo last change" affordance acts on: the newest
 * project-touching entry that has not already been undone. The ledger is
 * machine-global, so a blind `--last` could revert an unrelated project's
 * change — this filters to `touches_project` first, then picks the newest by
 * `time_unix` (not relying on inventory order). Null when there is nothing
 * safe to undo here.
 */
export function selectAgentstackUndoEntry(
  entries: ReadonlyArray<AgentstackRestoreEntryLike>,
): AgentstackRestoreEntryLike | null {
  let best: AgentstackRestoreEntryLike | null = null;
  for (const entry of entries) {
    if (!entry.touches_project || entry.undone) continue;
    if (best === null || entry.time_unix > best.time_unix) best = entry;
  }
  return best;
}

// ── policy tab ───────────────────────────────────────────────────────────────

// ── toolsets (Slice 2) ───────────────────────────────────────────────────────

export interface AgentstackToolsetLike {
  name: string;
  servers: ReadonlyArray<string>;
  skills: ReadonlyArray<string>;
  harness?: string | null | undefined;
  pinned: boolean;
  active?: boolean | undefined;
  blockers: ReadonlyArray<{ name: string; reason: string }>;
}

export interface AgentstackToolsetRow {
  name: string;
  /** e.g. `2 servers · 1 skill · for codex` */
  summary: string;
  /** One click from a session: pinned, and the project is trusted. */
  ready: boolean;
  active: boolean;
  /** Why it cannot start right now; null when ready. */
  blockedBecause: string | null;
}

/**
 * Rows for the toolset picker. Readiness here is advisory display — the CLI's
 * `session start` gate is the enforcement (it refuses untrusted projects and
 * unpinned/drifted surfaces regardless of what this renders). An untrusted or
 * drifted project blocks every row with the review pointer; otherwise the
 * first blocker's own actionable reason is surfaced.
 */
export function deriveToolsetRows(
  toolsets: ReadonlyArray<AgentstackToolsetLike>,
  trust: string,
): AgentstackToolsetRow[] {
  return toolsets.map((t) => {
    const parts = [
      `${t.servers.length} server${t.servers.length === 1 ? "" : "s"}`,
      `${t.skills.length} skill${t.skills.length === 1 ? "" : "s"}`,
    ];
    if (t.harness) parts.push(`for ${t.harness}`);
    const untrusted = trust !== "trusted";
    const ready = t.pinned && !untrusted;
    const blockedBecause = ready
      ? null
      : untrusted
        ? "review this project first — unreviewed content stays inert"
        : (t.blockers[0]?.reason ?? "not pinned — run agentstack lock");
    return {
      name: t.name,
      summary: parts.join(" · "),
      ready,
      active: t.active === true,
      blockedBecause,
    };
  });
}

export interface AgentstackPolicyRow {
  key: string;
  title: string;
  msg: string;
  level: AgentstackRowLevel;
}

/** The machine-policy ceiling + compiled-policy sections, verbatim. */
export function deriveAgentstackPolicyRows(report: AgentstackDoctorReport): AgentstackPolicyRow[] {
  const rows: AgentstackPolicyRow[] = [];
  for (const title of ["Machine policy", "Policy"]) {
    const section = sectionByTitle(report, title);
    section?.lines.forEach((l, i) => {
      rows.push({
        key: `${title}-${i}`,
        title,
        msg: l.msg.split("↳")[0]?.trim() ?? l.msg,
        level: (l.level === "warn" || l.level === "error" ? l.level : "ok") as AgentstackRowLevel,
      });
    });
  }
  return rows;
}

const SUMMARY_MAX = 64;

/** First line's message, trimmed to fit a one-line row. */
function firstMessage(section: AgentstackDoctorSection): string | undefined {
  const msg = section.lines[0]?.msg;
  if (!msg) return undefined;
  // Doctor lines carry a "↳ fix command" tail; the row only wants the fact.
  const fact = msg.split("↳")[0]?.trim() ?? msg;
  return fact.length > SUMMARY_MAX ? `${fact.slice(0, SUMMARY_MAX - 1)}…` : fact;
}

// ── recent-calls activity feed ───────────────────────────────────────────────

export interface AgentstackActivityEventLike {
  readonly ts: number;
  readonly server: string;
  readonly tool: string;
  readonly outcome: "ok" | "error" | "denied";
  readonly run?: string;
}

export interface AgentstackActivityRow {
  key: string;
  outcome: "ok" | "error" | "denied";
  /** `server__tool`, truncated — guard entries embed the whole command. */
  label: string;
  age: string;
  run?: string;
}

const ACTIVITY_LABEL_MAX = 48;

function formatAge(seconds: number): string {
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Feed events arrive oldest-first (audit-log append order, `ts` in epoch
 * seconds); the panel shows newest first.
 */
export function deriveAgentstackActivityRows(
  events: ReadonlyArray<AgentstackActivityEventLike>,
  nowEpochSeconds: number,
): AgentstackActivityRow[] {
  return events.toReversed().map((e, i) => {
    let label = `${e.server}__${e.tool}`;
    if (label.length > ACTIVITY_LABEL_MAX) {
      label = `${label.slice(0, ACTIVITY_LABEL_MAX - 1)}…`;
    }
    return {
      key: `${e.ts}-${i}`,
      outcome: e.outcome,
      label,
      age: formatAge(Math.max(0, nowEpochSeconds - e.ts)),
      ...(e.run ? { run: e.run } : {}),
    };
  });
}

// ── workflow tab ─────────────────────────────────────────────────────────────
// Field names mirror the `agentstack workflow …--json` wire format verbatim
// (snake_case), same convention as AgentstackCallEvent.

export interface AgentstackWorkflowSummaryLike {
  readonly name: string;
  readonly declared: boolean;
  readonly trusted: boolean;
  /** matches | drifted | missing | unavailable | resolve_failed. */
  readonly lock_status: string;
  readonly roles: ReadonlyArray<string>;
  readonly max_agents: number;
  readonly max_wall_seconds: number;
}

export interface AgentstackWorkflowStepLike {
  readonly step: number;
  readonly role: string;
  readonly label?: string | null;
  readonly child_run_id?: string | null;
  readonly state: "completed" | "failed" | "running" | "spawned";
  readonly outcome?: string | null;
  readonly tool_calls?: number;
  readonly duration_ms?: number | null;
  /** Recorded data-flow: prior step ids whose result text fed this prompt. */
  readonly taint?: ReadonlyArray<number>;
}

export interface AgentstackWorkflowRunLike {
  readonly run: string;
  readonly workflow: string;
  readonly workflow_digest?: string | null;
  readonly outcome: "completed" | "failed" | "running" | null;
  readonly exhausted: boolean;
  readonly duration_ms?: number | null;
  readonly max_agents: number;
  readonly max_wall_seconds: number;
  readonly steps: ReadonlyArray<AgentstackWorkflowStepLike>;
}

export interface AgentstackWorkflowStage {
  key: string;
  /** MAP / REDUCE / VERIFY / STEPS */
  title: string;
  steps: ReadonlyArray<AgentstackWorkflowStepLike>;
}

const KNOWN_STAGES: ReadonlyArray<[string, string]> = [
  ["map", "MAP"],
  ["reduce", "REDUCE"],
  ["verify", "VERIFY"],
];

/**
 * Group a run's steps into stages. Stages are NOT a first-class engine concept
 * — the engine records only steps and roles. When a script labels its steps by
 * convention (`map:…`, `reduce:…`, `verify:…`) we surface that grouping;
 * otherwise every step falls into a single "STEPS" stage. `labelled` reports
 * whether the grouping came from real labels (so the UI can note it's a
 * convention, not enforced structure).
 */
export function deriveWorkflowStages(steps: ReadonlyArray<AgentstackWorkflowStepLike>): {
  stages: AgentstackWorkflowStage[];
  labelled: boolean;
} {
  const buckets = new Map<string, AgentstackWorkflowStepLike[]>();
  let labelled = false;
  for (const step of steps) {
    const prefix = step.label?.split(":")[0]?.toLowerCase() ?? "";
    const known = KNOWN_STAGES.find(([p]) => p === prefix);
    const key = known ? known[1] : "STEPS";
    if (known) labelled = true;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(step);
  }
  const order = [...KNOWN_STAGES.map(([, t]) => t), "STEPS"];
  const stages = order
    .filter((title) => buckets.has(title))
    .map((title) => ({ key: title, title, steps: buckets.get(title)! }));
  return { stages, labelled };
}

export interface AgentstackWorkflowCounts {
  done: number;
  running: number;
  total: number;
}

/** Done = terminal steps; running = spawned but not terminal. "Queued" is not
 *  derivable (the script decides how many agents to spawn at runtime), so it is
 *  deliberately absent rather than guessed. */
export function deriveWorkflowCounts(
  steps: ReadonlyArray<AgentstackWorkflowStepLike>,
): AgentstackWorkflowCounts {
  let done = 0;
  let running = 0;
  for (const s of steps) {
    if (s.state === "completed" || s.state === "failed") done += 1;
    else running += 1;
  }
  return { done, running, total: steps.length };
}

/** Short digest for the pinned-sha chip: `sha256:9f2c…e1`. */
export function shortDigest(digest: string | undefined): string | undefined {
  if (!digest) return undefined;
  const hex = digest.replace(/^sha256:/, "");
  if (hex.length <= 10) return `sha256:${hex}`;
  return `sha256:${hex.slice(0, 4)}…${hex.slice(-2)}`;
}

// ── guard denials in the timeline ────────────────────────────────────────────

/** The marker every AgentStack guard denial carries, on every provider. */
const GUARD_MARKER = "agentstack guard blocked";

export interface AgentstackDenial {
  /** What was blocked — the command or file path the guard refused. */
  target: string;
  /** The policy rule name when the message names one (e.g. `!.env`). */
  rule?: string;
  /** Where the rule comes from, when stated (e.g. `machine policy`). */
  source?: string;
  /** The policy dimension the rule lives in (e.g. `filesystem` from `[policy.filesystem]`). */
  dimension?: string;
}

/**
 * Recognize an AgentStack guard denial in a work-log entry. Matches the
 * denial reason text, which is identical across providers (Claude surfaces
 * it via `tool.denied`, Codex embeds it in the hook-block error text).
 */
export function matchAgentstackDenial(entry: {
  label?: string;
  detail?: string;
  command?: string;
  failureText?: string;
}): AgentstackDenial | null {
  const text = [entry.failureText, entry.detail, entry.label, entry.command]
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
  if (!text.toLowerCase().includes(GUARD_MARKER)) return null;

  // "agentstack guard blocked this: <target>: denied by [policy.<dim>] deny
  //  rule "<rule>" (<source> — <file>)" — every capture is optional so an
  // unrecognized phrasing still renders a card with the raw target text.
  const afterMarker = /agentstack guard blocked this:\s*([^\n]+)/i.exec(text)?.[1] ?? "";
  const deniedBy = afterMarker.split(/:\s*denied by\s*/i);
  const target = (deniedBy[0] ?? afterMarker).trim();
  const rule = /deny rule "([^"]+)"/i.exec(text)?.[1];
  const source = /\(([^)—]+)\s*—/.exec(text)?.[1]?.trim();
  const dimension = /\[policy\.([a-z0-9_-]+)\]/i.exec(text)?.[1];

  return {
    target: target || "(command withheld)",
    ...(rule ? { rule } : {}),
    ...(source ? { source } : {}),
    ...(dimension ? { dimension } : {}),
  };
}

// ── path display ─────────────────────────────────────────────────────────────

/**
 * Shorten an absolute path for display in the panel's narrow column.
 *
 * The CLI's JSON reads return absolute paths on purpose — they are a machine
 * contract, and the setup plan's digest is taken over exactly what it sent, so
 * the payload itself is never rewritten. This is presentation only: inside the
 * project we show the path relative to its root, and anywhere else under the
 * user's home we collapse the prefix to `~`. A path outside both is returned
 * unchanged, because the whole path is then the information.
 *
 * `root` wins over `home` so a project inside the home directory reads
 * `.mcp.json` rather than `~/work/proj/.mcp.json`.
 */
export function shortenAgentstackPath(
  value: string,
  context: { root?: string | undefined; home?: string | undefined },
): string {
  if (!value) return value;
  const root = stripTrailingSep(context.root);
  if (root && value.startsWith(root + "/")) {
    const rel = value.slice(root.length + 1);
    return rel.length > 0 ? rel : value;
  }
  const home = stripTrailingSep(context.home);
  if (home && value.startsWith(home + "/")) return "~/" + value.slice(home.length + 1);
  return value;
}

function stripTrailingSep(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

/**
 * The same shortening applied to every absolute path *inside* a longer string
 * — a server's launch command, where the binary and its arguments are often
 * several home-relative paths in a row. Only `/`-rooted runs of non-space
 * characters are considered, so quoting and shell syntax survive untouched.
 */
export function shortenAgentstackPathsIn(
  value: string,
  context: { root?: string | undefined; home?: string | undefined },
): string {
  if (!value) return value;
  return value.replace(/\/[^\s'"]+/g, (match) => shortenAgentstackPath(match, context));
}

// ── the recommended next action ──────────────────────────────────────────────

/**
 * Map doctor's `next_action` command to a fixed panel action, when the panel
 * already exposes one that does exactly that.
 *
 * The panel used to print the recommended command as text you could not act
 * on, while the button that runs it lived a level deeper under "More
 * protection" — the one place we tell you what to do next was the one place
 * you could not do it.
 *
 * Deliberately a whitelist keyed on the leading verb, not a parser: an
 * unrecognized or flag-laden recommendation returns null and still renders as
 * a command to run in a terminal. Matching is exact after whitespace
 * collapsing, so `apply --write --scope global` does NOT silently become the
 * project-scoped apply.
 */
export function matchAgentstackNextAction(
  nextAction: string | null | undefined,
): AgentstackActionKind | null {
  if (!nextAction) return null;
  const normalized = nextAction.trim().replace(/\s+/g, " ");
  switch (normalized) {
    case "agentstack guard install":
      return "guard-install";
    case "agentstack apply --write":
      return "apply-project";
    case "agentstack apply --write --scope global":
      return "apply-global";
    default:
      return null;
  }
}

// ── library filtering ────────────────────────────────────────────────────────

/**
 * Case-insensitive substring filter over a library group's name and detail.
 *
 * The browser lists every skill and server the machine knows about in a ~360px
 * column; a library of any real size is unusable by scrolling alone. Matching
 * the detail text too means "postgres" finds a server whose description
 * mentions it but whose name does not. An empty or whitespace-only query
 * returns the list unchanged rather than nothing.
 */
export function filterAgentstackLibraryItems<T extends { name: string; detail: string | null }>(
  items: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter(
    (it) =>
      it.name.toLowerCase().includes(needle) || (it.detail ?? "").toLowerCase().includes(needle),
  );
}

// ── sharing (rung 5) ─────────────────────────────────────────────────────────

export interface AgentstackShareFacts {
  /** How many `${REF}` names the manifest carries — placeholders, never values. */
  readonly secretRefs: number;
  /** The reproducibility line as doctor reported it, when there is one. */
  readonly pinning: { readonly level: AgentstackRowLevel; readonly msg: string } | null;
}

/**
 * What the panel can honestly say about sharing this setup, read from the
 * doctor report it already has.
 *
 * Sharing has no panel *actions*: committing, signing, syncing a library and
 * exporting a bundle are all things the CLI owns, and two of them take a key
 * or a passphrase that must never enter a browser payload. So this view
 * explains what travels and hands over the exact commands — the same division
 * the secret-blocked card already uses.
 */
export function deriveAgentstackShareFacts(
  report: AgentstackDoctorReport | null,
): AgentstackShareFacts {
  if (!report) return { secretRefs: 0, pinning: null };
  const secrets = sectionByTitle(report, "Secrets");
  const repro = sectionByTitle(report, "Reproducibility");
  const first = repro?.lines[0];
  return {
    secretRefs: secrets?.lines.length ?? 0,
    pinning: first ? { level: asRowLevel(first.level), msg: first.msg } : null,
  };
}

/**
 * Narrow a doctor line's `level` to the closed set the panel styles by. The
 * wire type is an open string so a newer CLI can add a level without breaking
 * decode; anything unrecognized (today: `info`) renders muted rather than
 * borrowing the colour of a state it is not.
 */
function asRowLevel(level: string): AgentstackRowLevel {
  return level === "ok" || level === "warn" || level === "error" ? level : "muted";
}

/**
 * Split overview rows into what needs the user and what is merely fine.
 *
 * The panel used to render all four rows at equal weight, so a healthy
 * "Secrets" line competed with an error on "Checkup". Problems stay expanded;
 * the healthy ones collapse to a single reassurance line, which is the
 * progressive-disclosure rule the product states for every other surface.
 */
export function partitionAgentstackOverviewRows(rows: ReadonlyArray<AgentstackOverviewRow>): {
  readonly problems: ReadonlyArray<AgentstackOverviewRow>;
  readonly healthy: ReadonlyArray<AgentstackOverviewRow>;
} {
  const problems: AgentstackOverviewRow[] = [];
  const healthy: AgentstackOverviewRow[] = [];
  for (const row of rows) {
    // A row with something to click is actionable even when its level reads
    // "ok" — never collapse away an affordance.
    const actionable = row.reviewDrift === true || row.action !== undefined;
    if (row.level === "error" || row.level === "warn" || actionable) problems.push(row);
    else healthy.push(row);
  }
  return { problems, healthy };
}

/**
 * One line for everything that is fine — stated as outcomes, not as a list of
 * our category names.
 *
 * The panel used to render `rows.map(r => r.label).join(" · ") + " — all good"`,
 * which produced "Manifest · Checkup · Secrets · Library — all good": four
 * internal nouns, and it threw away what the rows had already established (how
 * many CLIs this manifest is in sync with, whether the secret refs resolve,
 * whether the skills are installed). Cross-CLI convergence is the product's
 * promise, so the one reassurance line is where it should be said.
 *
 * Every phrase comes from the row's `healthy` field, set at derivation where
 * the evidence is. Nothing is inferred from `summary` here — this line is the
 * panel's only unqualified "you're fine", so a claim it cannot source is a
 * claim it does not make: such a row degrades to naming itself, and a set with
 * nothing to say returns null so the caller renders no line at all.
 *
 * The Checkup row deliberately contributes nothing: the readiness chip
 * directly above already says Ready/Protected from the same doctor state, and
 * "checks pass" next to it is the same sentence twice.
 */
export function summarizeAgentstackHealthyRows(
  rows: ReadonlyArray<AgentstackOverviewRow>,
): string | null {
  const parts: string[] = [];
  for (const row of rows) {
    if (row.key === "doctor") continue;
    // `undefined` = no specific claim, name the row; `null` = say nothing.
    const phrase = row.healthy === undefined ? `${row.label.toLowerCase()} ok` : row.healthy;
    if (phrase !== null) parts.push(phrase);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── checkup findings ─────────────────────────────────────────────────────────

/** One of the remedies doctor named, split from any `label:` prefix. */
export interface AgentstackFixOption {
  /** The words before the colon ("keep them"), or null when there were none. */
  readonly label: string | null;
  /** The remedy itself — a command when `isCommand`, otherwise prose. */
  readonly text: string;
  /** True when `text` is something the user can actually run. */
  readonly isCommand: boolean;
}

export interface AgentstackFinding {
  readonly key: string;
  readonly level: AgentstackRowLevel;
  /** The finding, with the trailing `↳ <fix>` stripped off. */
  readonly message: string;
  /** The command doctor named as the fix, when it named one. */
  readonly fix: string | null;
  /**
   * The fix split into the separate choices doctor offered. Several remedies
   * are two alternatives joined by " · " ("keep them: agentstack adopt ·
   * prune them: agentstack apply --prune-foreign") — rendering that whole
   * string as one copyable command produces a line no shell will run.
   *
   * Each option carries its own label ("keep them") apart from its body, and
   * says whether that body is actually runnable: doctor also offers prose
   * alternatives ("· or reinstall the skill it points at"), and typesetting
   * prose as a command invites the user to paste it.
   */
  readonly fixOptions: ReadonlyArray<AgentstackFixOption>;
  /** Set when that fix is a fixed action this panel can run directly. */
  readonly action: AgentstackActionKind | null;
  /** Which doctor section it came from, for grouping. */
  readonly section: string;
}

/**
 * The longest finding the panel will draw before clipping it.
 *
 * Doctor lines interpolate repository-controlled strings verbatim — skill and
 * server names out of the manifest, instruction-fragment and target names,
 * paths. All repository content is hostile input and must be bounded before it
 * is rendered, and this list is the one place a doctor line reaches the DOM
 * whole (the overview rows clip at `SUMMARY_MAX`). React escapes it, so the
 * risk is not injection but a single 200 KB "skill name" owning the panel.
 * Generous enough that no real doctor line is ever touched.
 */
const FINDING_MAX = 240;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Split a doctor remedy into the alternatives it offered.
 *
 * Doctor composes them with " · " and usually prefixes each with a short label
 * ("keep them: agentstack adopt --scope global"). It also mixes in prose
 * alternatives that are not commands at all ("or reinstall the skill it points
 * at"), so each part is classified rather than assumed runnable.
 *
 * Every part is clamped on its own, so one long option cannot swallow the
 * other and the display bound still holds per rendered line.
 */
function splitFixOptions(fix: string): AgentstackFixOption[] {
  return fix
    .split(" · ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      // A label is a few plain words before a colon. Bounded deliberately: a
      // command can contain a colon of its own (a URL, a digest), and that
      // must not be mistaken for a label and hidden from the command line.
      const labelled = /^([A-Za-z][A-Za-z ']{0,23}):\s+(.+)$/.exec(part);
      const label = labelled?.[1] ?? null;
      const text = labelled?.[2] ?? part;
      return {
        label: label === null ? null : clamp(label, FINDING_MAX),
        text: clamp(text, FINDING_MAX),
        // Only agentstack's own verbs and the handful of shell commands doctor
        // actually suggests count as runnable; anything else is prose.
        isCommand: /^(agentstack|rm|mkdir|ln|brew|npx|git)\s/.test(text),
      };
    });
}

/**
 * Every error and warning doctor reported, with its fix.
 *
 * The Checkup row said "N warning(s) — each names its fix" and then showed
 * none of them: the panel already had every line and its remedy in the payload
 * it polls, and was rendering only a count. Doctor writes remedies as
 * `<message> ↳ <command>`, so the split is exact rather than guessed, and a
 * line without the marker simply has no fix to offer.
 */
export function deriveAgentstackFindings(
  report: AgentstackDoctorReport | null,
): ReadonlyArray<AgentstackFinding> {
  if (!report) return [];
  const out: AgentstackFinding[] = [];
  for (const section of report.sections) {
    for (const [i, line] of section.lines.entries()) {
      if (line.level !== "error" && line.level !== "warn") continue;
      const [message, ...rest] = line.msg.split("↳");
      const fix = rest.join("↳").trim();
      out.push({
        key: `${section.title}:${i}`,
        level: line.level === "error" ? "error" : "warn",
        message: clamp((message ?? line.msg).trim().replace(/\s+/g, " "), FINDING_MAX),
        fix: fix.length > 0 ? clamp(fix, FINDING_MAX) : null,
        fixOptions: fix.length > 0 ? splitFixOptions(fix) : [],
        // Match the action on the UNCLAMPED command: clipping is a display
        // concern and must not change which fixed action a fix maps to.
        action: fix.length > 0 ? matchAgentstackNextAction(fix) : null,
        section: clamp(section.title, 64),
      });
    }
  }
  return out;
}

/**
 * What the panel must see advertised before it will offer to RUN a fix it read
 * out of doctor's prose.
 *
 * Read this precisely: `status-v1` is `doctor --json` carrying `state` +
 * `next_action`, and that is exactly — only — what is being gated. The command
 * behind these buttons is not declared by the CLI; it is scraped from the
 * `↳ <command>` tail of a report line, so the question this gate answers is
 * "does this binary serve the doctor JSON contract whose shape we are reading",
 * not "does it support apply/guard-install". No feature name covers the writes
 * themselves: the actions are a closed set the SERVER maps to fixed argv, the
 * CLI re-validates every precondition, and the panel already fires the same
 * set ungated from the status row. So this narrows the surface (an older
 * binary gets the command as text, never a click) without pretending to
 * verify a contract nobody publishes.
 */
export const AGENTSTACK_CHECKUP_ACTION_FEATURE = "status-v1";

/**
 * The action this finding may be offered as a button, or null to show only its
 * command.
 */
export function agentstackFindingAction(
  finding: AgentstackFinding,
  features: ReadonlyArray<string> | undefined,
): AgentstackActionKind | null {
  if (finding.action === null) return null;
  // Drift is never one blind click, here or anywhere. The safe verb (adopt)
  // and the re-render verb (apply) differ, the scope has to be chosen, and the
  // Manifest row deliberately routes the same fact to the drift review instead
  // of firing `apply --write`. A "Re-render" button on a Drift finding is that
  // decision made twice, two rows apart, in opposite directions — and the
  // dangerous one wins because it is the one click.
  if (finding.section === "Drift") return null;
  return hasAgentstackFeature(features, AGENTSTACK_CHECKUP_ACTION_FEATURE) ? finding.action : null;
}

/**
 * How many findings the opened checkup list shows before "See all N".
 *
 * High enough that the second gate is rare. The list already sits behind a
 * disclosure, and a cap of 3 meant two clicks to read five short lines with no
 * way back — two gates for one small list. This one exists only to stop a
 * pathological report (a repo declaring forty broken skills) from turning the
 * panel into a scroll, so it fires where a cap is actually doing work.
 */
export const AGENTSTACK_FINDINGS_PREVIEW = 8;

/** A finding as the list draws it: the finding, plus the button it may show. */
export interface AgentstackFindingView {
  readonly finding: AgentstackFinding;
  /** The fixed action to offer, or null to show the command only. */
  readonly action: AgentstackActionKind | null;
}

/**
 * What the checkup list renders: errors first, then a preview of the rest,
 * each with the button it is allowed to show.
 *
 * Errors lead regardless of which section they came from — doctor's section
 * order is a report layout, and previewing three warnings while the single
 * error sits behind "See all" would bury the one finding that gates the
 * project. Order within a level is preserved, so the report's own sequence
 * still reads through.
 *
 * An action is offered at most once. Doctor reports machine-wide facts per
 * subject — four providers missing the guard hook are four warn lines all
 * ending `↳ agentstack guard install` — and four identical buttons for one
 * machine-wide write reads as four separate repairs. The first finding that
 * asks for an action keeps the button; the rest still show the command, which
 * is the honest picture: one fix, several symptoms.
 */
export function selectAgentstackFindingsView(
  findings: ReadonlyArray<AgentstackFinding>,
  expanded: boolean,
  features: ReadonlyArray<string> | undefined,
  previewCount: number = AGENTSTACK_FINDINGS_PREVIEW,
): {
  readonly visible: ReadonlyArray<AgentstackFindingView>;
  readonly hidden: number;
  readonly total: number;
} {
  const ranked = [
    ...findings.filter((f) => f.level === "error"),
    ...findings.filter((f) => f.level !== "error"),
  ];
  const limit = Math.max(0, previewCount);
  const shown = expanded ? ranked : ranked.slice(0, limit);
  const offered = new Set<AgentstackActionKind>();
  const visible = shown.map((finding) => {
    const action = agentstackFindingAction(finding, features);
    if (action === null || offered.has(action)) return { finding, action: null };
    offered.add(action);
    return { finding, action };
  });
  return { visible, hidden: ranked.length - visible.length, total: ranked.length };
}

// ── the one concern the first page shows ─────────────────────────────────────

/**
 * What each governed action is called, and what it promises.
 *
 * Lives here rather than in the component because the first page now picks a
 * concern and renders its verb from the same table the confirm step uses — two
 * copies of "Enable guard" is how the button and the sentence under it drift
 * apart.
 */
export const AGENTSTACK_ACTION_META: Record<
  AgentstackActionKind,
  { readonly label: string; readonly confirm: string; readonly note: string }
> = {
  "adopt-project": {
    label: "Keep edits",
    confirm:
      "Pull the on-disk hand-edits into this project's manifest. Only writes agentstack.toml — never rewrites or removes anything in a CLI's own config.",
    note: "only writes agentstack.toml",
  },
  "adopt-global": {
    label: "Keep edits",
    confirm:
      "Pull the on-disk hand-edits into this project's manifest at global scope. Only writes agentstack.toml — never rewrites or removes anything in a CLI's own config.",
    note: "only writes agentstack.toml",
  },
  "apply-project": {
    label: "Re-render",
    confirm:
      "Re-render this project's CLI config from the manifest. Overwrites hand-edits; keeps servers other setups applied and never prunes. Reversible with agentstack restore.",
    note: "reversible · never prunes",
  },
  "apply-global": {
    label: "Re-render",
    confirm:
      "Re-render the global CLI config from this manifest. Overwrites hand-edits; keeps servers other setups applied and never prunes. Reversible with agentstack restore.",
    note: "reversible · never prunes",
  },
  "guard-install": {
    label: "Enable guard",
    confirm:
      "Install the pre-tool-use guard into every detected CLI, machine-wide. Only adds protection; reversible with guard uninstall.",
    note: "reversible · only adds protection",
  },
};

/** Where the first page's one button goes. */
export type AgentstackConcernAct =
  | { readonly kind: "action"; readonly action: AgentstackActionKind }
  | { readonly kind: "review-drift" }
  | { readonly kind: "review-trust" }
  /** Nothing this panel can run — open Manage, where the detail lives. */
  | { readonly kind: "manage" };

export interface AgentstackPrimaryConcern {
  readonly key: string;
  /** The consequence, in the user's terms — not the doctor's section name. */
  readonly title: string;
  /** One sentence of why it matters. Null when the title says it all. */
  readonly detail: string | null;
  readonly act: AgentstackConcernAct;
  readonly label: string;
  /** What the button promises, e.g. "reversible · only adds protection". */
  readonly note: string | null;
  /** Everything else that needs the user, counted rather than listed. */
  readonly others: number;
}

/**
 * Curated copy for the concerns worth stating as a consequence.
 *
 * Doctor writes for an operator reading a report ("guard not enabled"); the
 * first page has room for exactly one problem and has to say why a stranger
 * should care. Only the cases we can recognise precisely get rewritten — every
 * other concern falls through to the report's own words, which is the honest
 * default. Nothing here changes what is true, only which side of it is said
 * first.
 */
const CONCERN_COPY: Record<string, { readonly title: string; readonly detail: string }> = {
  "guard-install": {
    title: "Agent commands run without a pre-check",
    detail:
      "Full-access mode turns off the provider's own approval prompts. The guard puts one back, machine-wide.",
  },
  "trust-inert": {
    title: "This project hasn't been reviewed yet",
    detail:
      "Until you review it, its servers and skills stay inert — nothing it declares can start or reach the network.",
  },
  "trust-drifted": {
    title: "Reviewed content changed on disk",
    detail:
      "Something this project pinned was edited since you approved it, so it is inert again until you review the new bytes.",
  },
  drift: {
    // Not "hand-edited": drift is also what a manifest change ahead of a
    // rendered file looks like, and the glance cannot tell the two apart. The
    // drift review can — it reads the CLI's per-target `hand_edited` — so the
    // cause is named there, and the concern states the choice instead.
    title: "A CLI config no longer matches the manifest",
    detail: "Keep what's on disk or re-render from the manifest — you choose which truth to keep.",
  },
};

/**
 * The single thing the first page shows, and how much else is waiting.
 *
 * The popover used to render every non-ok row, a collapsed findings list, a
 * healthy line and four nav rows at once — nine regions for a surface whose job
 * is "is this fine, and if not what do I press". This picks one: an unreviewed
 * or re-gated project first (it makes everything else moot), then drift (whose
 * verb is a choice, never a click), then any row or finding carrying an action,
 * then a bare error. Everything not picked becomes `others`, and lives one tap
 * away in Manage.
 */
export function selectAgentstackPrimaryConcern(input: {
  readonly rows: ReadonlyArray<AgentstackOverviewRow>;
  readonly findings: ReadonlyArray<AgentstackFinding>;
  readonly trust: AgentstackTrustState;
}): AgentstackPrimaryConcern | null {
  const { problems } = partitionAgentstackOverviewRows(input.rows);
  const total = problems.length + input.findings.length;
  /** Everything not shown here. Trust is picked from outside the rows, so it
   *  consumes none of them; every other branch consumes the one it picked. */
  const rest = (picked: number) => Math.max(0, total - picked);

  if (input.trust === "inert" || input.trust === "drifted") {
    const copy = CONCERN_COPY[input.trust === "inert" ? "trust-inert" : "trust-drifted"]!;
    return {
      key: `trust:${input.trust}`,
      title: copy.title,
      detail: copy.detail,
      act: { kind: "review-trust" },
      label: "Review this project",
      note: "you approve exact bytes",
      others: rest(0),
    };
  }

  const driftRow = problems.find((r) => r.reviewDrift === true);
  if (driftRow) {
    const copy = CONCERN_COPY.drift!;
    return {
      key: driftRow.key,
      title: copy.title,
      // The row summary is a status fragment ("changes pending on disk") and is
      // never empty, so preferring it made the curated line unreachable. The
      // concern card's job is to state the choice waiting for you, which is
      // what `copy.detail` says; the row's own summary still shows in the list.
      detail: copy.detail,
      act: { kind: "review-drift" },
      label: "Review",
      note: null,
      others: rest(1),
    };
  }

  const actionRow = problems.find((r) => r.action !== undefined);
  if (actionRow?.action) {
    const copy = CONCERN_COPY[actionRow.action];
    const meta = AGENTSTACK_ACTION_META[actionRow.action];
    return {
      key: actionRow.key,
      title: copy?.title ?? actionRow.summary,
      detail: copy?.detail ?? null,
      act: { kind: "action", action: actionRow.action },
      label: meta.label,
      note: meta.note,
      others: rest(1),
    };
  }

  const actionFinding = input.findings.find((f) => f.action !== null && f.section !== "Drift");
  if (actionFinding?.action) {
    const copy = CONCERN_COPY[actionFinding.action];
    const meta = AGENTSTACK_ACTION_META[actionFinding.action];
    return {
      key: actionFinding.key,
      title: copy?.title ?? actionFinding.message,
      detail: copy?.detail ?? null,
      act: { kind: "action", action: actionFinding.action },
      label: meta.label,
      note: meta.note,
      others: rest(1),
    };
  }

  const worst =
    problems.find((r) => r.level === "error") ??
    input.findings.find((f) => f.level === "error") ??
    problems[0] ??
    input.findings[0];
  if (!worst) return null;
  return {
    key: worst.key,
    title: "summary" in worst ? worst.summary : worst.message,
    detail: null,
    act: { kind: "manage" },
    label: "Open setup",
    note: null,
    others: rest(1),
  };
}

// ── setup plan ───────────────────────────────────────────────────────────────

/**
 * The collapsed summary of the setup plan's "What will be imported" group.
 *
 * The group counted servers only, so a plan that imports settings from two
 * tools and no servers summarized as "0 servers" — a true number that hid the
 * whole import. Both facts are stated, and "nothing to import" is said plainly
 * rather than as a zero.
 */
export function formatAgentstackImportSummary(input: {
  readonly servers: number;
  readonly settingsFrom: ReadonlyArray<string>;
}): string {
  const servers = Math.max(0, input.servers);
  const from = input.settingsFrom;
  const settings =
    from.length === 0
      ? null
      : from.length <= 2
        ? `settings from ${from.join(", ")}`
        : `settings from ${countOf(from.length, "tool")}`;
  if (servers === 0 && settings === null) return "nothing to import";
  const serverPart = servers > 0 ? countOf(servers, "server") : "no servers";
  return [serverPart, settings].filter((p): p is string => p !== null).join(" · ");
}
