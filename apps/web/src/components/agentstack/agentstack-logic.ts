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
  /**
   * static | clean-at-rest | zero-files — the project's delivery mode
   * (`doctor-mode-v1`). Null with no project; absent on older CLIs, where
   * nothing here may guess a mode from section prose.
   */
  mode?: string | null;
  /** locked | never_activated, same availability rules as `mode`. */
  activation?: string | null;
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
  | "guard-install"
  | "lock-write";

/**
 * The kinds a "what do I press here" surface may offer — the governed actions
 * plus the trust review.
 *
 * `review-trust` is deliberately NOT an `AgentstackActionKind`: granting trust
 * is content-bound consent, so it can only happen on the review screen that
 * shows the exact bytes being approved, never as fixed argv fired from a
 * button. It travels with the runnable kinds because every surface that names
 * `agentstack trust` as the next step needs somewhere to send you; each one
 * routes this kind to the review and never to the action RPC.
 */
export type AgentstackPanelActionKind = AgentstackActionKind | "review-trust";

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
 *
 * Counts only — no "open the list below". The row can be quoted where no list
 * follows (the popover's fallback concern), and where the list does follow it
 * is adjacent and open, so the pointer was either wrong or redundant.
 */
export function formatAgentstackCheckupSummary(errors: number, warnings: number): string {
  if (errors <= 0 && warnings <= 0) return "all checks pass";
  const parts = [
    errors > 0 ? countOf(errors, "error") : null,
    warnings > 0 ? countOf(warnings, "warning") : null,
  ].filter((p): p is string => p !== null);
  return parts.join(" · ");
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
    // Structured delivery mode (`doctor-mode-v1`): a zero-files project keeps
    // rendered configs off disk ON PURPOSE — the CLI skips the drift
    // comparison entirely for it, so neither "in sync" nor "rendered to N
    // CLIs" would be honest here (nothing was rendered or compared; the
    // gateway serves the project live). Before the typed field this state
    // could only be guessed from section prose, which is exactly the
    // substring-matching this field retires. Absent mode (older CLI) keeps
    // the prose-derived story below unchanged.
    const servedLive = report.mode === "zero-files";
    rows.push({
      key: "manifest",
      label: "Manifest",
      summary: servedLive
        ? "served live via the gateway — nothing rendered on purpose"
        : actionable
          ? "changes pending on disk"
          : foreignKept
            ? "in sync here · other setups' servers kept"
            : `in sync${cliCount ? ` · rendered to ${cliCount} CLIs` : ""}`,
      // `info`-only drift is not a fault (this project renders cleanly), so it
      // stays an "ok" dot; only real own-manifest drift warns.
      level: !servedLive && actionable ? "warn" : "ok",
      ...(!servedLive && (actionable || foreignKept) ? { reviewDrift: true as const } : {}),
      // Cross-CLI convergence is what the product promises, so it is what the
      // reassurance line should say — but only over CLIs doctor actually
      // compared. The count is of installed adapters whose config parses, all
      // of which are render targets, and `allInSync` covers every target.
      // Never claimed for a served-live project: no render was compared.
      ...(!servedLive && allInSync && cliCount
        ? { healthy: `${countOf(cliCount, "CLI")} in sync` }
        : {}),
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

// ── drift review narration ───────────────────────────────────────────────────

/**
 * The drift dialog's one-line story for a scope's changed targets. The CLI's
 * `existed_before` (contract `diff-existence-v1`) decides which of three
 * stories a pending change tells; the stopgap was inferring "first render"
 * from the `@@ -0,0` diff hunk header, which an empty-but-present file
 * misclassifies. Priority: an outside edit is the one the user must
 * adjudicate, so it wins; then "nothing rendered yet" — but only when EVERY
 * changed target is a first render (`neverRenderedCount === changedCount`),
 * because a mixed batch still holds files with content at stake; then the
 * neutral "manifest moved ahead". Older CLIs never report `existed_before`,
 * so their counts stay 0 and the wording is unchanged.
 */
export function describeAgentstackDriftStory(input: {
  readonly scope: "global" | "project";
  readonly changedCount: number;
  /** Changed targets with `hand_edited === true`. */
  readonly editedCount: number;
  /** Changed targets with `existed_before === false` (file absent on disk). */
  readonly neverRenderedCount: number;
}): string {
  const where = input.scope === "global" ? "global configs (~)" : "this repo";
  if (input.editedCount > 0) {
    return `The on-disk config in ${where} was edited outside agentstack. Pick which one is the truth.`;
  }
  if (input.changedCount > 0 && input.neverRenderedCount === input.changedCount) {
    return input.scope === "global"
      ? "Nothing is rendered in your global configs yet — “Re-render” writes them for the first time."
      : "Nothing is rendered in this repo yet — “Re-render” writes these configs for the first time.";
  }
  return `${input.scope === "project" ? "This repo" : "Your global configs"} no longer match the manifest. Pick which one is the truth.`;
}

export interface AgentstackProtectionRow {
  key: string;
  label: string;
  /**
   * Whether this layer is currently on, off, or unconfigured — null for the run
   * tiers, which are capabilities of the binary and have no state to report.
   *
   * Split out of `summary`, which used to open with a literal "on — " / "off — "
   * that the reader had to parse out of a sentence. A state is a chip, not a
   * prefix; leaving it in prose is why every row on the tab looked identical
   * whether it was protecting anything or not.
   */
  state: "on" | "off" | "unset" | null;
  /** What this layer covers, honestly — no claim beyond the enforcement. */
  summary: string;
  /** What turning it on costs (setup, dependencies, speed), when it isn't free. */
  cost?: string;
  /**
   * The command that uses this capability, where using it is terminal work.
   *
   * Kept apart from `summary` so the panel can typeset it as a command with a
   * copy affordance instead of burying argv mid-sentence.
   */
  command?: string;
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
      state: enabled ? "on" : "off",
      summary: enabled
        ? "Blocks destructive agent commands before they run."
        : "Agent commands run without a pre-check.",
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
  const machineMsg = machine ? (firstMessage(machine, { clip: false }) ?? "") : "";
  if (machine) {
    const unconfigured = machineMsg.startsWith("unconfigured");
    rows.push({
      key: "machine-policy",
      label: "Machine policy",
      state: unconfigured ? "unset" : "on",
      summary: unconfigured
        ? "Each project uses its own limits."
        : `The ceiling every session runs under — ${machineMsg}`,
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
      state: registered > 0 ? "on" : "off",
      summary:
        registered > 0
          ? `${formatAgentstackCount(registered, "CLI")} fetch servers live; unreviewed repos stay inert.`
          : "Servers render as config files instead.",
      cost: "review each repo once before its servers run",
      level: registered > 0 ? worstLevel(gateway) : "muted",
    });
  }

  // Standing run tiers — capabilities of the binary, never claimed active.
  rows.push({
    key: "locked-run",
    label: "Locked run",
    state: null,
    summary: "Pins content and records evidence for one run.",
    cost: "host process — not kernel isolation",
    command: "agentstack run <cli> --locked",
    level: "muted",
  });
  rows.push({
    key: "sandbox",
    label: "Sandbox",
    state: null,
    summary: "Container isolation; lockdown also enforces the network route.",
    cost: "needs Docker · slower start",
    command: "agentstack run <cli> --sandbox",
    level: "muted",
  });

  return rows;
}

/**
 * A finding that says a CLI's config is on disk but its binary is not.
 *
 * Matched on doctor's phrase, positively: if doctor rewords it we simply stop
 * offering the extra affordance, which is the safe direction — the finding
 * still renders, we just say less about it.
 *
 * Worth singling out because it is the one finding class the checkup shows
 * that names no fix and has no governed action, so it renders as a warning the
 * reader cannot answer. The answer is real, though: `[targets]` in the
 * manifest decides which CLIs commands act on, so dropping the name there
 * stops AgentStack managing a tool that is not installed.
 */
export function isAgentstackAbsentAdapterFinding(finding: AgentstackFinding): boolean {
  return finding.message.includes("config present but binary not on PATH");
}

// ── delivery mode ────────────────────────────────────────────────────────────

export interface AgentstackModeFacts {
  /** Plain-language name for the mode; never the internal token. */
  readonly label: string;
  /** What it means for files on this machine, in one sentence. */
  readonly detail: string;
  /**
   * Whether a rendered config file exists on disk between sessions.
   *
   * This is the load-bearing bit. Every screen that names an on-disk path is
   * making a claim that only holds when this is true: in clean-at-rest the
   * file exists only while a session is open, and in zero-files it never
   * exists at all. A path shown without that qualification tells a user to go
   * look for something that is not there — and, worse, makes the absence read
   * as a bug rather than as the mode working.
   */
  readonly persistsOnDisk: boolean;
}

/**
 * What delivery mode this project is in, in the user's words.
 *
 * `doctor-mode-v1`. Null when the CLI does not report a mode (older binary) or
 * doctor ran with no project — in both cases the panel must say nothing rather
 * than guess, because guessing wrong here mislabels whether the user's files
 * should exist.
 *
 * A mode the panel does not recognize still yields facts: the token is shown
 * as-is and treated as persisting, which is the conservative direction (it
 * keeps paths qualified rather than silently promising they are permanent).
 */
export function describeAgentstackMode(
  mode: string | null | undefined,
): AgentstackModeFacts | null {
  if (mode === null || mode === undefined || mode === "") return null;
  switch (mode) {
    case "static":
      return {
        label: "Files on disk",
        detail:
          "Each coding tool reads a config file AgentStack writes here. The files stay between sessions.",
        persistsOnDisk: true,
      };
    case "clean-at-rest":
      return {
        label: "Only while in use",
        detail:
          "Config files appear when you start using this toolset and are removed when you stop. Nothing is left on disk in between.",
        persistsOnDisk: false,
      };
    case "zero-files":
      return {
        label: "Served live",
        detail:
          "Nothing is written to disk. Your coding tools fetch this project's servers from AgentStack while they run.",
        persistsOnDisk: false,
      };
    default:
      return { label: mode, detail: "", persistsOnDisk: true };
  }
}

/** One delivery mode as the chooser presents it. `word` is the footer's
 *  clickable spelling; `title`/`desc` are the option card. */
export interface AgentstackModeOption {
  readonly mode: "static" | "clean-at-rest" | "zero-files";
  readonly word: string;
  readonly title: string;
  readonly desc: string;
}

/**
 * The three delivery modes, in the order the chooser lists them. One
 * vocabulary for the footer word and the option cards, so the word someone
 * clicks and the option they land on can never drift apart.
 */
export const AGENTSTACK_MODE_OPTIONS: ReadonlyArray<AgentstackModeOption> = [
  {
    mode: "static",
    word: "on disk",
    title: "On disk",
    desc: "Config files in each CLI, kept out of git. Works with every CLI, zero moving parts.",
  },
  {
    mode: "zero-files",
    word: "served live",
    title: "Served live",
    desc: "Nothing written into this repo; your CLIs fetch capabilities from AgentStack.",
  },
  {
    mode: "clean-at-rest",
    word: "only while you work",
    title: "Only while you work",
    desc: "Files appear when you start and are put back exactly as they were when you stop.",
  },
];

/** The footer's word for a doctor-reported mode; the raw label for a mode
 *  this build doesn't know (a future CLI must not render as blank). */
export function agentstackModeWord(mode: string | null | undefined): string | null {
  if (mode === null || mode === undefined || mode === "") return null;
  return AGENTSTACK_MODE_OPTIONS.find((o) => o.mode === mode)?.word ?? mode;
}

/**
 * Whether this project has ever been activated (`doctor-mode-v1`).
 *
 * Kept apart from the mode: "never activated" explains an absent lockfile and
 * absent configs regardless of which mode the manifest asks for, and conflating
 * the two would report a mode's normal state as a fault.
 */
export function describeAgentstackActivation(activation: string | null | undefined): string | null {
  return activation === "never_activated"
    ? "Not activated yet — nothing has been written for this project."
    : null;
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
 * Derive the single status chip. "Protected" is a strictly stronger "Ready":
 * it appears only when the project is ready AND both cooperative host
 * protections (the pre-tool-use guard and a machine policy ceiling) are on.
 * It is deliberately NOT a claim of sandboxing.
 *
 * `readiness` is the honest verdict (`status-honesty-v1`) and wins when the
 * caller passes it — the caller only does so when the CLI advertises the
 * feature, never sniffed. `state` answers "did any check find something to
 * repair?", which reads `ready` over an untrusted, never-activated project;
 * that mislabel (E2E finding F1) is exactly what `readiness` replaces. An
 * unrecognized readiness word falls through to the `state` reading, and when
 * both are absent (older CLI) the chip is null and the caller falls back to
 * the row rollup.
 */
export function deriveAgentstackStatusChip(input: {
  state?: string | null | undefined;
  /** Only pass under `status-honesty-v1`; null/absent reads by `state`. */
  readiness?: string | null | undefined;
  protection?: AgentstackProtection | null | undefined;
}): AgentstackStatusChip | null {
  const ready = () => {
    const isProtected =
      input.protection?.guard === true && input.protection?.machine_policy === true;
    return isProtected
      ? { label: "Protected", level: "ok" as const, isProtected: true }
      : { label: "Ready", level: "ok" as const, isProtected: false };
  };
  switch (input.readiness) {
    case "needs_setup":
      return { label: "Needs setup", level: "warn", isProtected: false };
    case "needs_attention":
      return { label: "Needs attention", level: "warn", isProtected: false };
    // The consent gate is what stands between here and live — say so in
    // review language rather than a generic warning.
    case "untrusted":
      return { label: "Review pending", level: "warn", isProtected: false };
    case "drifted":
      return { label: "Needs re-review", level: "warn", isProtected: false };
    // Consented or not, nothing was ever rendered/declared: not a fault, but
    // not live either — the one case `state` called "Ready".
    case "never_activated":
      return { label: "Not active yet", level: "warn", isProtected: false };
    case "empty":
      return { label: "Nothing declared", level: "warn", isProtected: false };
    case "ready":
      return ready();
    default:
      break;
  }
  switch (input.state) {
    case "needs_setup":
      return { label: "Needs setup", level: "warn", isProtected: false };
    case "needs_attention":
      return { label: "Needs attention", level: "warn", isProtected: false };
    case "ready":
      return ready();
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

// ── edit preview classification ──────────────────────────────────────────────

export type AgentstackEditPreviewOutcome<P> =
  /** A digestable preview: the confirm step can run. */
  | { kind: "confirm"; digest: string; preview: P }
  /** The CLI said no and named why — show ITS sentence, never "update". */
  | { kind: "refused"; message: string }
  /** No answer at all: RPC failed, spawn failed, or the CLI timed out. */
  | { kind: "unavailable" }
  /** The CLI answered but its preview carries no digest — genuinely old. */
  | { kind: "unsupported" };

/**
 * Sort one preview result into the four things it can mean. The flow used to
 * test only "is there a digest", which told a correct CLI refusal (deleting
 * the only toolset widens access) apart from nothing and re-captioned it
 * "update agentstack" — guidance that is wrong in both halves: updating won't
 * help, and the terminal would refuse identically. The order is fixed:
 * no-answer first (nothing was said), then the digest (the CLI's yes), then
 * the refusal (the CLI's no), and "unsupported" only as the remainder — a
 * decoded answer that offers nothing to confirm against.
 */
export function classifyAgentstackEditPreview<
  P extends { readonly consent_digest?: string | null },
>(
  result: {
    readonly preview: P | null;
    readonly refusal?: string | null;
    readonly unavailable?: boolean;
  } | null,
): AgentstackEditPreviewOutcome<P> {
  if (result === null || result.unavailable === true) return { kind: "unavailable" };
  const digest = result.preview?.consent_digest ?? null;
  if (result.preview && digest !== null && digest !== undefined) {
    return { kind: "confirm", digest, preview: result.preview };
  }
  const refusal = result.refusal ?? null;
  if (refusal !== null && refusal.trim().length > 0) {
    return { kind: "refused", message: refusal };
  }
  return { kind: "unsupported" };
}

// ── doctor probe (server startup test) ───────────────────────────────────────

/** One stdio server's `doctor --probe` result, decoupled from the wire type. */
export interface AgentstackProbeServerLike {
  readonly server: string;
  /** ok | failed | not_probeable */
  readonly status: string;
  readonly detail?: string | null;
  readonly server_name?: string | null;
  readonly tools?: number | null;
  readonly elapsed_ms?: number;
}

export interface AgentstackProbeRow {
  readonly name: string;
  readonly level: AgentstackRowLevel;
  readonly text: string;
}

/**
 * One display row per probed server, in the CLI's own vocabulary: `ok` says
 * what started and what it offered, `failed` repeats the CLI's sanitized
 * reason, `not_probeable` is a warning (the launch is blocked, usually by an
 * unresolved `${REF}`), and an unknown status from a newer CLI degrades to a
 * warning that shows the raw word rather than guessing at its meaning.
 */
export function deriveAgentstackProbeRows(
  servers: ReadonlyArray<AgentstackProbeServerLike>,
): Array<AgentstackProbeRow> {
  return servers.map((s) => {
    if (s.status === "ok") {
      const who = s.server_name ?? null;
      const tools =
        typeof s.tools === "number" ? `${formatAgentstackCount(s.tools, "tool")}` : "handshake OK";
      const ms = typeof s.elapsed_ms === "number" ? `started in ${s.elapsed_ms}ms` : "started";
      return {
        name: s.server,
        level: "ok",
        text: [ms, who, tools].filter((p): p is string => p !== null).join(" · "),
      };
    }
    if (s.status === "failed") {
      return { name: s.server, level: "error", text: s.detail ?? "failed to start" };
    }
    if (s.status === "not_probeable") {
      return { name: s.server, level: "warn", text: s.detail ?? "can't be started from here" };
    }
    return { name: s.server, level: "warn", text: s.detail ?? s.status };
  });
}

/**
 * The skipped-probe explanation. `ran: false` is a first-class answer from
 * the CLI — it refuses to start servers for a project that is not trusted at
 * its current bytes — so the copy points at the trust review, never at a
 * retry (which would return the same refusal forever).
 */
export function describeAgentstackProbeSkip(reason: string | null | undefined): {
  text: string;
  reviewTrust: boolean;
} {
  if (reason === "untrusted") {
    return {
      text: "Nothing was started — this project isn't trusted yet, so its servers won't be run. Review this project first.",
      reviewTrust: true,
    };
  }
  if (reason === "drifted") {
    return {
      text: "Nothing was started — the manifest or lockfile changed since this project was trusted. Review this project again.",
      reviewTrust: true,
    };
  }
  return { text: "Nothing was started.", reviewTrust: false };
}

/**
 * Whether a failed session start was the trust gate refusing.
 *
 * The CLI's own sentence is what the panel shows ("refusing to start a session:
 * … review with `agentstack trust` …"), and it is the right sentence — but it
 * names a terminal command in a window that owns a review screen. Recognising
 * the refusal is what lets the same line carry a button.
 *
 * Substring matching on purpose, not a parse: the wording travels between CLI
 * versions and this decides only whether to ADD an affordance, so a miss costs
 * the button and never the message. Any non-string, empty or unrecognized input
 * is simply not a refusal.
 */
export function matchAgentstackTrustRefusal(message: string | null | undefined): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  const text = message.toLowerCase();
  return text.includes("refusing to start a session") || text.includes("agentstack trust");
}

/**
 * The CLI's line as the panel shows it once it has recognized the refusal.
 *
 * Only the `error: ` prefix goes — it is the CLI's stream marker, and inside a
 * card that is already styled as a failure it reads as part of the sentence.
 * Everything else, including the wording and the backticked command, stays
 * verbatim.
 */
export function stripAgentstackErrorPrefix(message: string): string {
  return message.replace(/^\s*error:\s*/i, "");
}

// ── workflow serial roles ────────────────────────────────────────────────────

/**
 * The scheduling sentence for one workflow row: which of its roles run their
 * children one at a time, and why that is true despite the agent ceiling.
 *
 * Returns null when there is nothing to warn about — no serial roles, or a CLI
 * that does not advertise the contract (the caller passes `known: false` there,
 * so an older binary stays silent rather than implying full parallelism it
 * never claimed either way).
 */
export function describeAgentstackSerialRoles(input: {
  readonly serialRoles: ReadonlyArray<string> | undefined;
  readonly maxAgents: number;
  readonly known: boolean;
}): string | null {
  if (!input.known) return null;
  const serial = input.serialRoles ?? [];
  if (serial.length === 0) return null;
  const names = serial.join(", ");
  const which = serial.length === 1 ? `${names} runs` : `${names} run`;
  // The ceiling is the thing that misleads: it is real, and it does not apply
  // to these roles, so state both rather than only the cap.
  return `${which} one child at a time — that harness takes no per-child MCP config, so the ≤${input.maxAgents} ceiling doesn't apply to it.`;
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
  /**
   * The command the ledger recorded ("apply", "use 'web'"). Absent on a CLI
   * that predates the field; untrusted display text either way.
   */
  operation?: string | undefined;
}

/** One ledger row as the undo drawer renders it. */
export interface AgentstackUndoLedgerRow {
  /** Full hex id — what a per-entry revert presents to `restore <id> --write`. */
  readonly id: string;
  readonly summary: string;
  /** The recorded command ("apply", "use 'web'"), or null on an older CLI. */
  readonly operation: string | null;
  readonly time_unix: number;
  readonly touchesProject: boolean;
  readonly undone: boolean;
  /**
   * Whether the drawer offers Revert on this row: it touches this project and
   * has not already been undone. Rows outside the project stay visible but
   * inert — the ledger is machine-global, and reverting another project's
   * write from here is the blind `--last` this drawer exists to avoid; they
   * are shown (not hidden) so "latest" can never read as a false claim about
   * the ledger.
   */
  readonly canUndo: boolean;
}

/**
 * The whole ledger as a browsable list, newest first by `time_unix` (never
 * trusting inventory order). This replaced a single-entry pick: collapsing the
 * ledger to one "Undo last change" button made every older recoverable write
 * unreachable from the panel, though `restore <id> --write` — the exact action
 * the button already invoked — serves any entry.
 */
export function deriveAgentstackUndoLedger(
  entries: ReadonlyArray<AgentstackRestoreEntryLike>,
): AgentstackUndoLedgerRow[] {
  return [...entries]
    .sort((a, b) => b.time_unix - a.time_unix)
    .map((e) => ({
      id: e.id,
      summary: e.summary,
      operation: e.operation ?? null,
      time_unix: e.time_unix,
      touchesProject: e.touches_project,
      undone: e.undone,
      canUndo: e.touches_project && !e.undone,
    }));
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
/**
 * The first line's fact, clipped to fit a compact row.
 *
 * `clip: false` for surfaces with room to finish the sentence. The Protection
 * tab is one: it is the screen whose entire job is stating what is enforced,
 * and it was describing the machine ceiling as `a rename-proof "*" rule (or a
 * filesystem scope) c…` — a claim the reader cannot finish, cut by a cap that
 * exists for a 400px popover row.
 */
function firstMessage(
  section: AgentstackDoctorSection,
  { clip = true }: { clip?: boolean } = {},
): string | undefined {
  const msg = section.lines[0]?.msg;
  if (!msg) return undefined;
  // Doctor lines carry a "↳ fix command" tail; the row only wants the fact.
  const fact = msg.split("↳")[0]?.trim() ?? msg;
  if (!clip || fact.length <= SUMMARY_MAX) return fact;
  return `${fact.slice(0, SUMMARY_MAX - 1)}…`;
}

// ── recent-calls activity feed ───────────────────────────────────────────────

/** One brokered call, as the CLI's feed spells it. */
export interface AgentstackCallEventLike {
  readonly kind?: "call";
  readonly ts: number;
  readonly server: string;
  readonly tool: string;
  readonly outcome: "ok" | "error" | "denied";
  readonly ms?: number;
  readonly run?: string;
  readonly args_digest?: string;
  readonly detail?: string;
}

/**
 * One skill the agent pulled into its own context (`activity-skill-load-v1`).
 * Nothing was brokered, so there is no outcome and no duration to carry — the
 * shape says so rather than defaulting them to something that reads like a
 * successful call.
 */
export interface AgentstackSkillLoadEventLike {
  readonly kind: "skill_load";
  readonly ts: number;
  readonly name: string;
  readonly reason: string;
  readonly run?: string;
  readonly project?: string;
}

export type AgentstackActivityEventLike = AgentstackCallEventLike | AgentstackSkillLoadEventLike;

interface AgentstackActivityRowBase {
  key: string;
  /** `server__tool` for a call, the skill name for a load; truncated — guard
   *  entries embed the whole command. */
  label: string;
  age: string;
  run?: string;
  /** Short run id for display; the full value stays in `run`. */
  runShort?: string;
  /**
   * The row's second line, bounded and flattened before it reaches the DOM.
   * On a call it is why the call ended the way it did — set only when it did
   * NOT succeed, because a reason on an ok row explains nothing. On a load it
   * is the agent's own words for why it wanted the skill.
   */
  reason?: string;
}

export interface AgentstackActivityCallRow extends AgentstackActivityRowBase {
  kind: "call";
  outcome: "ok" | "error" | "denied";
  /** First hex chars of the argument digest. Never an argument value. */
  digest?: string;
  duration?: string;
}

/**
 * A load is informational, not an outcome: it was neither allowed nor denied,
 * so the row deliberately carries none of the ok/denied/error vocabulary and
 * the panel must not colour it with one.
 */
export interface AgentstackActivitySkillLoadRow extends AgentstackActivityRowBase {
  kind: "load";
}

export type AgentstackActivityRow = AgentstackActivityCallRow | AgentstackActivitySkillLoadRow;

const ACTIVITY_LABEL_MAX = 48;
/**
 * An `error` detail is one of a handful of fixed classes the gateway
 * substitutes for upstream text, so a hostile server cannot choose it. A
 * `denied` detail is NOT so constrained: a gateway denial renders a policy rule
 * out of the project manifest, and a host-guard denial embeds the path the
 * agent asked for — both repository- or agent-influenced, i.e. hostile input.
 *
 * That is safe to render as a text child (React escapes it) once it is bounded
 * and flattened, which is what this does: control characters out, whitespace
 * collapsed, length capped. The recorder's own guarantees are about what it
 * writes; this is the one place that text reaches the DOM.
 */
const ACTIVITY_REASON_MAX = 120;
/** Digests are already 12 hex chars from the recorder; bounded anyway. */
const ACTIVITY_DIGEST_MAX = 12;

/**
 * Make a recorded string safe to draw: control characters out, whitespace
 * collapsed, length capped. See `ACTIVITY_REASON_MAX` above for why the risk
 * here is a 200 KB "reason" owning the panel rather than injection.
 *
 * Shared so every CLI-sourced string on this screen gets the SAME treatment —
 * a second, kinder copy written for a newer field is exactly how one of them
 * ends up unbounded.
 */
export function sanitizeAgentstackRecordedText(text: string, max: number): string {
  return clamp(
    text
      // Control characters first: a filename may legally contain them, and
      // they survive a whitespace collapse.
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Feed events arrive oldest-first (audit-log append order, `ts` in epoch
 * seconds); the panel shows newest first.
 *
 * Skill loads (`activity-skill-load-v1`) are interleaved by the CLI and stay
 * exactly where it put them: the merged order is the recorded order, and
 * re-sorting here would make this panel tell a different story about one run
 * than the terminal's own `report run` does.
 */
export function deriveAgentstackActivityRows(
  events: ReadonlyArray<AgentstackActivityEventLike>,
  nowEpochSeconds: number,
): AgentstackActivityRow[] {
  return events.toReversed().map((e, i) => {
    const key = `${e.ts}-${i}`;
    const age = formatAge(Math.max(0, nowEpochSeconds - e.ts));
    const run = e.run ? { run: e.run, runShort: e.run.slice(0, 8) } : {};
    if (e.kind === "skill_load") {
      return {
        kind: "load",
        key,
        // The skill's name is the whole label: a load has no server and no
        // tool, and inventing a `server__tool` pair would dress it up as a
        // call — the one thing this row must never look like.
        label: sanitizeAgentstackRecordedText(e.name, ACTIVITY_LABEL_MAX),
        age,
        ...run,
        // The agent's own words for why it wanted this skill, which is the
        // fact that makes the row worth a line. Bounded exactly like a call's
        // reason: both are text an MCP caller chose.
        ...(e.reason.trim() !== ""
          ? { reason: sanitizeAgentstackRecordedText(e.reason, ACTIVITY_REASON_MAX) }
          : {}),
      };
    }
    let label = `${e.server}__${e.tool}`;
    if (label.length > ACTIVITY_LABEL_MAX) {
      label = `${label.slice(0, ACTIVITY_LABEL_MAX - 1)}…`;
    }
    return {
      kind: "call",
      key,
      outcome: e.outcome,
      label,
      age,
      ...run,
      // The question this feed exists to answer is "why did it fail", so the
      // reason rides on the row rather than waiting behind an expander — but
      // only where there is a failure to explain.
      ...(e.detail && e.outcome !== "ok"
        ? { reason: sanitizeAgentstackRecordedText(e.detail, ACTIVITY_REASON_MAX) }
        : {}),
      // Sliced, not clamped: an ellipsis would read as part of the digest, and
      // the recorder already emits exactly this many hex chars.
      ...(e.args_digest ? { digest: e.args_digest.slice(0, ACTIVITY_DIGEST_MAX) } : {}),
      // A guard denial records no duration at all (it never called anything),
      // so a literal "0ms" on every blocked row would be noise dressed as data.
      ...(typeof e.ms === "number" && Number.isFinite(e.ms) && e.ms > 0
        ? { duration: formatMs(e.ms) }
        : {}),
    };
  });
}

function formatMs(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  return v < 1_000 ? `${v}ms` : `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)}s`;
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
 *
 * `agentstack trust` maps to `review-trust`, which is a destination rather than
 * a write: the caller opens the review screen. Recommending it and rendering it
 * as unclickable text was the panel's longest-standing dead end — the one state
 * that makes everything else moot was the one state with nothing to press.
 */
export function matchAgentstackNextAction(
  nextAction: string | null | undefined,
): AgentstackPanelActionKind | null {
  if (!nextAction) return null;
  const normalized = nextAction.trim().replace(/\s+/g, " ");
  // Doctor recommends `trust` with the project's own absolute path — which the
  // exact-match list below can never contain. A path is a destination, not a
  // flag, so accepting `trust <one-path>` keeps the whitelist's promise: any
  // flagged form (`--revoke`, `--yes`) still falls through to plain text. The
  // review screen the caller opens is scope-free either way — it always shows
  // this project's own surface.
  if (/^agentstack trust \/[^\s-][^\s]*$/.test(normalized)) return "review-trust";
  switch (normalized) {
    case "agentstack guard install":
      return "guard-install";
    case "agentstack trust":
    case "agentstack trust .":
      return "review-trust";
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
  /**
   * Set when that fix is something this panel can offer directly: a fixed
   * action it runs, or — for `agentstack trust` — the review screen it opens.
   */
  readonly action: AgentstackPanelActionKind | null;
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
 * The affordance one finding's remedy earns.
 *
 * Two bars, because the two outcomes differ in kind. A runnable action fires
 * fixed argv, so it keeps the exact-match whitelist and a near-miss degrades to
 * text. The trust review only OPENS a screen — it shows the bytes and grants
 * nothing by itself — so it is offered whenever the remedy NAMES `agentstack
 * trust`, which is how doctor actually writes it: "review + agentstack trust"
 * for a re-gated project, and `agentstack trust <path>` where it names the root.
 * Demanding an exact match there is what left the panel's most consequential
 * finding printing a command and nothing else.
 */
function findingFixAffordance(fix: string): AgentstackPanelActionKind | null {
  const exact = matchAgentstackNextAction(fix);
  if (exact !== null) return exact;
  // Word-bounded, so a longer verb (`trust-store`) never reads as `trust`.
  return /(^|\s)agentstack\s+trust(\s|$)/i.test(fix) ? "review-trust" : null;
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
      // Advisories are collected too, as `muted`. They are NOT faults — the
      // CLI keeps them out of `warnings` and out of `state` on purpose — but
      // dropping them here left the reader with a bare count beside the chip
      // ("· 2 notes") and no way to see or answer them. A leftover config for
      // an uninstalled editor is the case in point: nothing is broken, and the
      // remedy is still a real edit. Shown quietly, ranked last, and barred
      // from becoming the one thing the first page asks you to do.
      if (line.level !== "error" && line.level !== "warn" && line.level !== "advisory") continue;
      const [message, ...rest] = line.msg.split("↳");
      const fix = rest.join("↳").trim();
      out.push({
        key: `${section.title}:${i}`,
        level: line.level === "error" ? "error" : line.level === "advisory" ? "muted" : "warn",
        message: clamp((message ?? line.msg).trim().replace(/\s+/g, " "), FINDING_MAX),
        fix: fix.length > 0 ? clamp(fix, FINDING_MAX) : null,
        fixOptions: fix.length > 0 ? splitFixOptions(fix) : [],
        // Match on the UNCLAMPED command: clipping is a display concern and
        // must not change which action or review a fix maps to.
        action: fix.length > 0 ? findingFixAffordance(fix) : null,
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
): AgentstackPanelActionKind | null {
  if (finding.action === null) return null;
  // Drift is never one blind click, here or anywhere. The safe verb (adopt)
  // and the re-render verb (apply) differ, the scope has to be chosen, and the
  // Manifest row deliberately routes the same fact to the drift review instead
  // of firing `apply --write`. A "Re-render" button on a Drift finding is that
  // decision made twice, two rows apart, in opposite directions — and the
  // dangerous one wins because it is the one click.
  if (finding.section === "Drift") return null;
  // The trust review is this panel's own screen, not a scraped command handed
  // to the action RPC, so the feature that gates RUNNING a fix has nothing to
  // say about it — and a finding that names `agentstack trust` is exactly the
  // one that must not be left as text on every binary.
  if (finding.action === "review-trust") return "review-trust";
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
  /** The action or review to offer, or null to show the command only. */
  readonly action: AgentstackPanelActionKind | null;
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
    ...findings.filter((f) => f.level !== "error" && f.level !== "muted"),
    // Last: an advisory is worth reading, never worth reading first.
    ...findings.filter((f) => f.level === "muted"),
  ];
  const limit = Math.max(0, previewCount);
  const shown = expanded ? ranked : ranked.slice(0, limit);
  const offered = new Set<AgentstackPanelActionKind>();
  const visible = shown.map((finding) => {
    const action = agentstackFindingAction(finding, features);
    if (action === null || offered.has(action)) return { finding, action: null };
    offered.add(action);
    return { finding, action };
  });
  return { visible, hidden: ranked.length - visible.length, total: ranked.length };
}

/**
 * Plain-language names for the doctor sections whose CLI titles are internal
 * vocabulary. Display only: grouping, dedup and the drift/trust routing all
 * key on the CLI's own title, so a rename here can never change behavior. A
 * title not named here renders verbatim — a new doctor section must never be
 * hidden or mistranslated by an older panel.
 */
const AGENTSTACK_SECTION_DISPLAY: Readonly<Record<string, string>> = {
  // The same fact the Protection sheet calls "Live serving"; one name for one
  // mechanism, and the internal architecture word stays in the CLI report.
  "Zero-files gateway": "Live serving",
};

export function describeAgentstackFindingSection(title: string): string {
  return AGENTSTACK_SECTION_DISPLAY[title] ?? title;
}

export interface AgentstackFindingGroup {
  /** The doctor section these findings came from; unique within the list. */
  readonly key: string;
  readonly section: string;
  /** The worst level in the group — a group is as urgent as its worst member. */
  readonly level: AgentstackRowLevel;
  readonly items: ReadonlyArray<AgentstackFindingView>;
  /** The one action the whole group offers, if any member offered one. */
  readonly action: AgentstackPanelActionKind | null;
}

const LEVEL_RANK: Record<AgentstackRowLevel, number> = { error: 3, warn: 2, ok: 1, muted: 0 };

/**
 * Fold the checkup list into one block per doctor section.
 *
 * Four drifted CLIs are four findings, and each one rendered its own identical
 * "Review" button opening the same dialog — four ways to ask the same question,
 * which reads as four problems. Grouping keeps every finding visible (nothing
 * here is hidden; the count is the honest one) and moves the verb to the group,
 * so a section offers its action once.
 *
 * Order is first-appearance, which preserves the errors-first ranking
 * `selectAgentstackFindingsView` already applied: the section holding the worst
 * finding leads.
 */
export function groupAgentstackFindingViews(
  views: ReadonlyArray<AgentstackFindingView>,
): ReadonlyArray<AgentstackFindingGroup> {
  const order: string[] = [];
  const bySection = new Map<string, AgentstackFindingView[]>();
  for (const view of views) {
    const section = view.finding.section;
    const bucket = bySection.get(section);
    if (bucket === undefined) {
      order.push(section);
      bySection.set(section, [view]);
    } else {
      bucket.push(view);
    }
  }
  return order.map((section) => {
    const items = bySection.get(section) ?? [];
    return {
      key: section,
      section,
      level: items.reduce<AgentstackRowLevel>(
        (worst, v) => (LEVEL_RANK[v.finding.level] > LEVEL_RANK[worst] ? v.finding.level : worst),
        "muted",
      ),
      items,
      // `selectAgentstackFindingsView` already offers each action at most once
      // across the whole list, so at most one member carries a non-null action.
      action: items.find((v) => v.action !== null)?.action ?? null,
    };
  });
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
  "lock-write": {
    label: "Activate",
    confirm:
      "Pin this project's servers and skills into agentstack.lock. Nothing is rendered and no skill is materialized — this only records what the manifest currently resolves to, which is what trust is then bound against.",
    note: "pins content · renders nothing",
  },
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
    title: "Your coding tool configs changed outside AgentStack",
    detail: "Keep what's on disk or re-render from the manifest — you choose which truth to keep.",
  },
  // The two verdicts only `readiness` can state (`status-honesty-v1`): a
  // findings-free project that still isn't live. Before the field, this exact
  // state wore a Ready chip (E2E finding F1).
  "never-activated": {
    title: "Set up but not active yet",
    detail:
      "Nothing this project declares is live in your coding tools until it is activated once.",
  },
  empty: {
    title: "This setup declares nothing yet",
    detail:
      "The manifest exists but lists no servers, skills, or instructions — add something to it before activating.",
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
  /**
   * The doctor's honest verdict (`status-honesty-v1`), or null when the CLI
   * doesn't advertise it. Two jobs: an authoritative source for the
   * consent-gate states (`untrusted`/`drifted`) ahead of the trust badge's
   * prose fallback, and the only source for `never_activated`/`empty` — the
   * findings-free not-live states nothing else here can see.
   */
  readonly readiness?: string | null;
}): AgentstackPrimaryConcern | null {
  // Prefer readiness for the consent-gate reading; the badge-derived `trust`
  // (which falls back to section prose on older CLIs) remains for the rest.
  const trust: AgentstackTrustState =
    input.readiness === "untrusted"
      ? "inert"
      : input.readiness === "drifted"
        ? "drifted"
        : input.trust;
  // The Checkup row is a pointer at the findings list, not a problem of its
  // own — counting it beside the findings it summarizes counted every warning
  // twice, and "2 more in Manage" over one warning is a claim the reader can
  // check and find false.
  const problems = partitionAgentstackOverviewRows(input.rows).problems.filter(
    (r) => r.key !== "doctor",
  );
  // Advisories are excluded outright: this function answers "what is the one
  // thing to do here", and an advisory answers "nothing". Counting them would
  // also inflate the "N more in Manage" tally with things that need nobody.
  const findings = input.findings.filter((f) => f.level !== "muted");
  const total = problems.length + findings.length;
  /** Everything not shown here. Trust is picked from outside the rows, so it
   *  consumes none of them; every other branch consumes the one it picked. */
  const rest = (picked: number) => Math.max(0, total - picked);

  if (trust === "inert" || trust === "drifted") {
    const copy = CONCERN_COPY[trust === "inert" ? "trust-inert" : "trust-drifted"]!;
    return {
      key: `trust:${trust}`,
      title: copy.title,
      detail: copy.detail,
      act: { kind: "review-trust" },
      label: "Review this project",
      note: "you approve exactly what you review",
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

  const actionFinding = findings.find((f) => f.action !== null && f.section !== "Drift");
  if (actionFinding?.action === "review-trust") {
    // A checkup line asking for `agentstack trust` while the trust state above
    // reads neither inert nor drifted — a stale or unreadable trust record. The
    // destination is the same review either way, so it is offered rather than
    // demoted to "Open setup".
    return {
      key: actionFinding.key,
      title: actionFinding.message,
      detail: null,
      act: { kind: "review-trust" },
      label: "Review & use",
      note: "you approve exactly what you review",
      others: rest(1),
    };
  }
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

  // The readiness-only verdicts: findings-free, trusted, and still not live.
  // Only reachable via `readiness` (`status-honesty-v1`), so an older CLI
  // simply never shows them — which is the pre-honesty behavior, not a lie.
  if (input.readiness === "never_activated") {
    const copy = CONCERN_COPY["never-activated"]!;
    const meta = AGENTSTACK_ACTION_META["lock-write"];
    return {
      key: "readiness:never_activated",
      title: copy.title,
      detail: copy.detail,
      act: { kind: "action", action: "lock-write" },
      label: meta.label,
      note: meta.note,
      others: rest(0),
    };
  }
  if (input.readiness === "empty") {
    const copy = CONCERN_COPY.empty!;
    return {
      key: "readiness:empty",
      title: copy.title,
      detail: copy.detail,
      act: { kind: "manage" },
      label: "Open setup",
      note: null,
      others: rest(0),
    };
  }

  const worst =
    problems.find((r) => r.level === "error") ??
    findings.find((f) => f.level === "error") ??
    problems[0] ??
    findings[0];
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

// ── header posture ───────────────────────────────────────────────────────────

/** What the popover header chip says, and whether the trigger dot warns. */
export type AgentstackPanelPosture = "hidden" | "ready" | "attention";

/**
 * One posture for the header chip and the trigger dot, derived in the SAME
 * order as the body's region switch — that ordering is the contract. The
 * header used to read only the primary concern, so a project whose body said
 * "not set up yet" wore a Ready chip above it: setup is a body branch, not a
 * concern, and the two claims were derived separately. Any state whose body
 * region asks the user for something (update needed, setup, a concern) is
 * `attention`; `ready` is reserved for the working-under region; everything
 * the chip cannot honestly summarize (still checking, unreachable, not
 * installed, unreadable doctor) stays `hidden` and lets the body speak alone.
 */
export function deriveAgentstackPanelPosture(input: {
  readonly hasStatus: boolean;
  readonly installed: boolean;
  readonly unreachable: boolean;
  readonly doctorReadable: boolean;
  readonly incompatible: boolean;
  readonly setupState: string | null;
  /**
   * The doctor's honest verdict (`status-honesty-v1`), or null when the CLI
   * doesn't advertise it. Anything except `ready` means "not live", so the
   * chip may not say ready over it — the F1 mislabel was exactly `state`
   * saying "ready" for an untrusted, never-activated project.
   */
  readonly readiness: string | null;
  readonly hasConcern: boolean;
}): AgentstackPanelPosture {
  if (input.hasStatus && input.installed && input.incompatible) return "attention";
  if (input.hasStatus && input.installed && input.setupState === "needs_setup") {
    return "attention";
  }
  if (input.unreachable || !input.hasStatus || !input.installed || !input.doctorReadable) {
    return "hidden";
  }
  // `unknown` (doctor ran with no project verdict) claims nothing either way,
  // so it falls through to the concern reading like an absent field.
  if (input.readiness !== null && input.readiness !== "unknown" && input.readiness !== "ready") {
    return "attention";
  }
  return input.hasConcern ? "attention" : "ready";
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

// ── trust review ─────────────────────────────────────────────────────────────

export interface AgentstackTrustServerLike {
  readonly name: string;
  /** stdio | http | unverified | unresolvable */
  readonly kind: string;
  readonly target: string;
}

/** One risk-ordered band of the servers a repo declares. */
export interface AgentstackTrustGroup {
  readonly key: "unverified" | "unresolvable" | "stdio" | "http";
  /** What consenting to this band actually permits, in plain words. */
  readonly title: string;
  readonly note: string;
  readonly level: AgentstackRowLevel;
  readonly servers: ReadonlyArray<AgentstackTrustServerLike>;
}

export interface AgentstackTrustSurface {
  readonly groups: ReadonlyArray<AgentstackTrustGroup>;
  /** One line for the pinned verdict bar: what saying yes covers. */
  readonly summary: string;
  readonly serverCount: number;
}

/**
 * Order the trust surface by what consenting to it actually grants, and
 * summarize it in one line.
 *
 * The review is a wall when a repo declares twenty servers: a flat list buries
 * both the decision and the one entry that deserved a second look. Four bands,
 * most-consequential first:
 *
 *   1. unverified — the definition on disk no longer matches its lockfile pin.
 *      The highest-stakes row on the screen, and the one most easily mistaken
 *      for a benign misconfiguration, so it leads and it is never merged with
 *      the band below.
 *   2. unresolvable — the name resolves to nothing, so it will not run and
 *      cannot be judged.
 *   3. stdio — runs a command on this machine. The broadest capability here.
 *   4. http — reaches a host over the network.
 *
 * Ordering within a band is left exactly as the CLI emitted it: the preview's
 * order is the manifest's order, and reordering it would make two reviews of
 * the same repo look different for no reason.
 */
export function deriveTrustSurface(
  servers: ReadonlyArray<AgentstackTrustServerLike>,
  extra: {
    readonly skills: number;
    readonly workflows: number;
    readonly extensions: number;
    readonly instructions: number;
    readonly secrets: number;
    /**
     * Only under `trust-review-card-v1` (pass 0 otherwise): hooks are an
     * executable kind, so a bar that omitted them summarized a smaller
     * surface than the one being approved.
     */
    readonly hooks?: number;
    readonly settings?: number;
  },
): AgentstackTrustSurface {
  const of = (kind: string) => servers.filter((s) => s.kind === kind);
  const stdio = of("stdio");
  const http = of("http");
  const unverified = of("unverified");
  // Everything else, including a kind a newer CLI invents: over-warning is the
  // safe direction, and silently dropping a row would understate the surface.
  const unresolvable = servers.filter(
    (s) => s.kind !== "stdio" && s.kind !== "http" && s.kind !== "unverified",
  );

  const groups: AgentstackTrustGroup[] = [];
  if (unverified.length > 0) {
    groups.push({
      key: "unverified",
      // NOT "can't be resolved": this one resolves fine. Its bytes changed
      // since they were pinned, which is the opposite of a typo and reads as
      // one if the two are shown under a single heading.
      title: "Changed since it was pinned",
      note: "The definition on disk no longer matches the lockfile pin, so what it would run can't be shown or checked.",
      level: "warn",
      servers: unverified,
    });
  }
  if (unresolvable.length > 0) {
    groups.push({
      key: "unresolvable",
      title: "Can't be resolved",
      note: "You can't see what these would run. Approving covers them anyway.",
      level: "warn",
      servers: unresolvable,
    });
  }
  if (stdio.length > 0) {
    groups.push({
      key: "stdio",
      title: "Run a command on this machine",
      note: "Each one starts the program named below, with your user's access.",
      level: "ok",
      servers: stdio,
    });
  }
  if (http.length > 0) {
    groups.push({
      key: "http",
      title: "Reach a host over the network",
      note: "Each one can send and receive data from the address below.",
      level: "ok",
      servers: http,
    });
  }

  const parts = [
    countOf(servers.length, "server"),
    // Verb agreement matters here: this line is read at the moment of consent,
    // and "1 run commands" is the kind of seam that makes a reader wonder what
    // else on the screen was generated rather than written.
    stdio.length > 0
      ? `${stdio.length} ${stdio.length === 1 ? "runs a command" : "run commands"}`
      : null,
    http.length > 0
      ? `${http.length} ${http.length === 1 ? "reaches the network" : "reach the network"}`
      : null,
    unverified.length > 0 ? `${unverified.length} changed since pinned` : null,
    unresolvable.length > 0 ? `${unresolvable.length} unresolvable` : null,
    // Everything else the repo declares. Omitting these let the bar read
    // "nothing declared" for a repo with no servers but three workflows —
    // each of which names the agent roles it may spawn — which is a false
    // statement in the one line guaranteed to be on screen at consent.
    extra.skills > 0 ? countOf(extra.skills, "skill") : null,
    extra.workflows > 0 ? countOf(extra.workflows, "workflow") : null,
    extra.extensions > 0 ? countOf(extra.extensions, "extension") : null,
    extra.instructions > 0 ? countOf(extra.instructions, "instruction") : null,
    // Executable like the stdio band, so the bar may not omit them.
    (extra.hooks ?? 0) > 0 ? countOf(extra.hooks!, "hook") : null,
    (extra.settings ?? 0) > 0 ? `settings for ${countOf(extra.settings!, "tool")}` : null,
    // Named last and never omitted when present: these are the values the
    // project's declared capabilities become able to read.
    extra.secrets > 0 ? countOf(extra.secrets, "secret") : null,
  ].filter((p): p is string => p !== null);

  return {
    groups,
    serverCount: servers.length,
    summary: servers.length === 0 && parts.length <= 1 ? "nothing declared" : parts.join(" · "),
  };
}

// ── consent card (trust-card-diff-v1) ────────────────────────────────────────
// The per-item review the terminal has always printed, as data. Everything
// here is display derivation: the gate is the CLI's, the digest covers the
// whole surface, and nothing on this screen may read as a per-item decision.

/** Wire shape: one file inside a pinned item's diff. */
export interface AgentstackReviewFileLike {
  readonly path: string;
  readonly change: "added" | "removed" | "modified";
  readonly added: number;
  readonly removed: number;
  /** Null when the CLI capped the diff, or the file has no body to show. */
  readonly lines?: ReadonlyArray<string> | null;
}

/** Wire shape: a pinned item's byte-level story, pin to pin. */
export interface AgentstackReviewDiffLike {
  readonly status: "no_snapshot" | "unchanged" | "changed";
  readonly headline: string | null;
  readonly files: ReadonlyArray<AgentstackReviewFileLike>;
  readonly capped: boolean;
}

/** Wire shape: one capability in the review. */
export interface AgentstackReviewItemLike {
  readonly kind: string;
  readonly name: string;
  readonly change: "added" | "changed" | "unchanged";
  readonly identity: string;
  readonly runs: ReadonlyArray<string>;
  readonly contacts: ReadonlyArray<string>;
  readonly may_read: ReadonlyArray<string>;
  readonly pin: string | null;
  readonly prior_pin: string | null;
  readonly recognized_other_projects: number | null;
  readonly diff: AgentstackReviewDiffLike | null;
}

/** Wire shape: the whole `review` object on the preview. */
export interface AgentstackReviewLike {
  readonly re_review: boolean;
  readonly prior_recorded: boolean;
  readonly items: ReadonlyArray<AgentstackReviewItemLike>;
  readonly removed: ReadonlyArray<{
    readonly kind: string;
    readonly name: string;
    readonly identity: string;
  }>;
}

/** One "runs: …" / "contacts: …" / "may read: …" line under an item. */
export interface AgentstackReviewFact {
  readonly key: "runs" | "contacts" | "may read";
  readonly value: string;
}

export interface AgentstackReviewDiffFileView {
  readonly key: string;
  readonly path: string;
  /** "+1 −1" for a modified file; "added" / "removed" for the others, where
   *  counts of zero would read as "nothing happened". */
  readonly counts: string;
  /** The classified lines, or null when only counts are available. */
  readonly parsed: AgentstackParsedDiff | null;
}

export interface AgentstackReviewDiffView {
  /** `changed` shows what moved; `no_snapshot` is the honest degrade. */
  readonly kind: "changed" | "no_snapshot";
  readonly headline: string | null;
  readonly files: ReadonlyArray<AgentstackReviewDiffFileView>;
  /** True when no line body is available — the CLI capped it, or the change is
   *  file-level only. The counts stay exact either way. */
  readonly countsOnly: boolean;
  /** The sentence that says what this view is NOT showing. Always paired with
   *  the terminal-review line the panel keeps at the bottom. */
  readonly note: string | null;
  /** The two pin identities, for a degrade that has nothing else to show. */
  readonly pins: string | null;
}

export interface AgentstackReviewRow {
  readonly key: string;
  /** The CLI's own kind word, bounded. A kind this build has never heard of
   *  still gets a row: dropping it would understate the surface. */
  readonly kind: string;
  /** Empty for kinds that are their own row (`secrets`, `policy`). */
  readonly name: string;
  readonly identity: string;
  /** Null when there is nothing to mark: unchanged, or a first consent, where
   *  every item is new and "added" on all of them marks nothing. */
  readonly badge: "added" | "changed" | null;
  readonly facts: ReadonlyArray<AgentstackReviewFact>;
  /** The content behind this item is pinned, so a byte change re-opens the
   *  review rather than sliding in under an old yes. */
  readonly pinned: boolean;
  /** Display only, and worded so it can never read as part of the gate. */
  readonly recognition: string | null;
  readonly diff: AgentstackReviewDiffView | null;
}

export interface AgentstackReviewCardView {
  readonly rows: ReadonlyArray<AgentstackReviewRow>;
  readonly removed: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly name: string;
    readonly identity: string;
  }>;
  /** True when at least one row actually draws a diff — the panel's drift
   *  paragraph may only promise marks when there are marks. */
  readonly showsDiff: boolean;
  /** Rows marked added or changed; zero on a first consent, by construction. */
  readonly markedCount: number;
}

/** Item strings are repository content. Bounded like every other one. */
const REVIEW_TEXT_MAX = 160;
/** A joined `runs:` line can carry several full command lines. */
const REVIEW_FACT_MAX = 240;
/** Per diff line, before the shared line cap applies. */
const REVIEW_DIFF_LINE_MAX = 200;

function reviewFacts(item: AgentstackReviewItemLike): AgentstackReviewFact[] {
  const join = (values: ReadonlyArray<string>) =>
    sanitizeAgentstackRecordedText(
      values.map((v) => sanitizeAgentstackRecordedText(v, REVIEW_TEXT_MAX)).join(" · "),
      REVIEW_FACT_MAX,
    );
  return (
    [
      { key: "runs", values: item.runs },
      { key: "contacts", values: item.contacts },
      { key: "may read", values: item.may_read },
    ] as const
  )
    .filter((f) => f.values.length > 0)
    .map((f) => ({ key: f.key, value: join(f.values) }));
}

function reviewDiffView(
  item: AgentstackReviewItemLike,
  diff: AgentstackReviewDiffLike,
): AgentstackReviewDiffView | null {
  if (diff.status === "unchanged") return null;
  const pins =
    item.prior_pin !== null && item.pin !== null
      ? `was ${shortDigest(item.prior_pin)} · now ${shortDigest(item.pin)}`
      : null;
  if (diff.status === "no_snapshot") {
    return {
      kind: "no_snapshot",
      headline: null,
      files: [],
      countsOnly: true,
      // Said plainly, because the alternative is a review that shows an empty
      // diff and lets it read as "nothing changed".
      note: "The content changed since your last yes, and there's no approved snapshot left to compare it against.",
      pins,
    };
  }
  const files = diff.files.map((f, i) => ({
    key: `${i}-${f.path}`,
    path: sanitizeAgentstackRecordedText(f.path, REVIEW_TEXT_MAX),
    counts:
      f.change === "modified"
        ? `+${f.added} −${f.removed}`
        : f.change === "added"
          ? "added"
          : "removed",
    parsed:
      f.lines != null && f.lines.length > 0
        ? parseAgentstackDiff(
            f.lines.map((l) => sanitizeAgentstackRecordedText(l, REVIEW_DIFF_LINE_MAX)).join("\n"),
          )
        : null,
  }));
  const countsOnly = files.every((f) => f.parsed === null);
  return {
    kind: "changed",
    headline:
      diff.headline === null
        ? null
        : sanitizeAgentstackRecordedText(diff.headline, REVIEW_TEXT_MAX),
    files,
    countsOnly,
    // The cap hides detail, never scale — and the terminal review is where the
    // rest of it is, which the panel says at the bottom of every review.
    note: countsOnly
      ? "Too large to show here — the counts above are exact, and the full line-by-line review is in the terminal."
      : null,
    pins,
  };
}

/**
 * Turn the CLI's `review` object into rows the card can draw.
 *
 * Two rules do the work here, and both come from the CLI's own semantics:
 *
 *  1. `change` follows an item's IDENTITY, not its bytes. An inline skill whose
 *     body was edited still reads `unchanged`, with the byte story in its pins
 *     and its `diff`. So an item is marked changed when EITHER moved — reading
 *     `change` alone would show a re-review where nothing appears to have
 *     changed, which is the exact question the re-review is asking.
 *  2. `prior_recorded: false` means the marks carry no information: there is no
 *     recorded surface to compare against, so every item reads `added` and
 *     marking all of them says nothing. That review is a first consent, and it
 *     is drawn without marks and without diffs.
 *
 * `showDiffs` is the panel's context (a drifted project, or a re-review) — a
 * never-approved project must never be told its content "changed since your
 * last yes", because there was no last yes.
 */
export function deriveAgentstackReviewCard(
  review: AgentstackReviewLike,
  options: { readonly showDiffs: boolean },
): AgentstackReviewCardView {
  const marks = review.prior_recorded;
  const showDiffs = options.showDiffs && review.prior_recorded;
  const rows = review.items.map((item, i): AgentstackReviewRow => {
    const bytesMoved = item.diff?.status === "changed";
    const badge: "added" | "changed" | null = !marks
      ? null
      : item.change === "added"
        ? "added"
        : item.change === "changed" || bytesMoved
          ? "changed"
          : null;
    const recognized = item.recognized_other_projects;
    return {
      key: `${i}-${item.kind}-${item.name}`,
      kind: sanitizeAgentstackRecordedText(item.kind, REVIEW_TEXT_MAX),
      name: sanitizeAgentstackRecordedText(item.name, REVIEW_TEXT_MAX),
      identity: sanitizeAgentstackRecordedText(item.identity, REVIEW_TEXT_MAX),
      badge,
      facts: reviewFacts(item),
      pinned: item.pin !== null,
      // "already approved", never "safe" and never a count that could be read
      // as a vote: other projects' decisions do not lower this project's gate.
      recognition:
        typeof recognized === "number" && recognized > 0
          ? `these exact contents are already approved in ${countOf(recognized, "other project")} on this machine`
          : null,
      diff: showDiffs && item.diff !== null ? reviewDiffView(item, item.diff) : null,
    };
  });
  return {
    rows,
    removed: review.removed.map((r, i) => ({
      key: `${i}-${r.kind}-${r.name}`,
      kind: sanitizeAgentstackRecordedText(r.kind, REVIEW_TEXT_MAX),
      name: sanitizeAgentstackRecordedText(r.name, REVIEW_TEXT_MAX),
      identity: sanitizeAgentstackRecordedText(r.identity, REVIEW_TEXT_MAX),
    })),
    showsDiff: rows.some((r) => r.diff !== null),
    markedCount: rows.filter((r) => r.badge !== null).length,
  };
}

/**
 * The last sentence of the drifted-project paragraph.
 *
 * The terminal review stays authoritative either way — the panel keeps its
 * `agentstack trust <path>` line at the bottom regardless. What changes is
 * whether this screen may claim to mark the changes itself: it may only say so
 * when a diff is actually on screen, which is why the card is derived first and
 * this sentence is chosen from it.
 */
export function describeAgentstackDriftReviewTail(showsDiff: boolean): string {
  return showsDiff
    ? "What changed since your last yes is marked below."
    : "The terminal review marks exactly what changed since your last yes.";
}

// ── version mismatch ─────────────────────────────────────────────────────────

/**
 * The one place this panel names the application hosting it.
 *
 * The panel is one host integration, not the product — so the handful of
 * strings that must name a host name it here rather than inline, and a second
 * host changes one line instead of hunting three. (The CLI itself never needs
 * this: it is the authority in every integration.)
 */
export const AGENTSTACK_HOST_NAME = "t3code";

/** What the version-mismatch screen can offer as a way out. */
export type AgentstackUpdateOffer =
  | { readonly kind: "install"; readonly label: string }
  | { readonly kind: "download"; readonly label: string }
  | { readonly kind: "check"; readonly label: string }
  | { readonly kind: "none"; readonly note: string };

/**
 * Turn the host's update state into the one verb this screen should offer.
 *
 * The screen correctly refuses to act on data it cannot fully read, but it
 * offered no way forward — a dead end in a product that already knows how to
 * update itself. Where that path exists it is named precisely (downloading and
 * installing are different acts with different costs); where it does not, the
 * screen says so instead of showing a button that cannot work.
 */
export function selectAgentstackUpdateOffer(input: {
  /** False in a browser, where there is no self-update path to offer. */
  readonly isDesktop: boolean;
  readonly action: "download" | "install" | "none";
  readonly canCheck: boolean;
  /**
   * The host's update status, so work already in flight can be named.
   *
   * Spelled out rather than typed `string`: this module declares its own
   * unions instead of importing, and a `string` would let a typo fall silently
   * into the "unavailable" copy — the exact falsehood this argument exists to
   * prevent. `undefined` means the host has not reported yet, which is not the
   * same as having nothing to report.
   */
  readonly status?:
    | "disabled"
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "downloaded"
    | "error"
    | undefined;
}): AgentstackUpdateOffer {
  if (!input.isDesktop) {
    return {
      kind: "none",
      note: `Open this project in the ${AGENTSTACK_HOST_NAME} desktop app to update, or downgrade the CLI to the version this build understands.`,
    };
  }
  // Ordered by how far along the update already is, so the button never asks
  // for work the host has already done.
  if (input.action === "install") return { kind: "install", label: "Restart to update" };
  if (input.action === "download") return { kind: "download", label: "Download update" };
  // An update already in flight also has no button — but it is emphatically
  // not "unavailable", and saying so while one downloads would be false. Both
  // of these states make `canCheck` false, so they must be answered before the
  // unavailable case rather than falling into it.
  if (input.status === "downloading") {
    return {
      kind: "none",
      note: "An update is downloading. You'll be able to restart into it once it finishes.",
    };
  }
  if (input.status === "checking") {
    return { kind: "none", note: "Checking for updates…" };
  }
  if (input.canCheck) return { kind: "check", label: "Check for updates" };
  // The host has not reported yet. That is not the same as having no update
  // path, and claiming one would be asserting something we have not been told.
  if (input.status === undefined) {
    return { kind: "none", note: "Checking for updates…" };
  }
  return {
    kind: "none",
    note: `Automatic updates are unavailable in this build. Install a newer ${AGENTSTACK_HOST_NAME}, or downgrade the CLI to the version it understands.`,
  };
}

// ── unified diff ─────────────────────────────────────────────────────────────

/**
 * What a single diff line is, for colouring.
 *
 * `meta` covers the file headers (`diff --git`, `index`, `--- a/…`, `+++ b/…`)
 * that must NOT be counted or coloured as content: `--- a/x` starts with `-`
 * and would otherwise read as a deleted line, which is how a two-file diff ends
 * up claiming two extra deletions.
 */
export type AgentstackDiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface AgentstackDiffLine {
  /** Stable across renders: the line's own index, which cannot repeat. */
  readonly key: string;
  readonly kind: AgentstackDiffLineKind;
  /** The line with its leading marker removed; the marker is drawn separately. */
  readonly text: string;
}

export interface AgentstackParsedDiff {
  readonly lines: ReadonlyArray<AgentstackDiffLine>;
  readonly additions: number;
  readonly deletions: number;
  /** True when `lines` stops short of the diff — the tail was dropped. */
  readonly truncated: boolean;
}

/**
 * How many lines we will draw for one target.
 *
 * The CLI's diff for a machine-wide config runs to hundreds of lines, and every
 * one of them is a DOM node inside an already-scrolling dialog. The cap is on
 * lines rather than characters (the old 6,000-char slice) because a character
 * cut lands mid-token and renders a line that is not in the file.
 */
const DIFF_LINE_CAP = 300;

/**
 * Split unified-diff text into classified, counted lines.
 *
 * The panel gets `diff` as pre-rendered unified text from `agentstack diff
 * --json`, not as structured hunks, so classification is by leading marker.
 * Treated as untrusted like everything else here: any shape parses, and an
 * empty or marker-less string simply yields context lines.
 */
export function parseAgentstackDiff(diff: string): AgentstackParsedDiff {
  if (!diff) return { lines: [], additions: 0, deletions: 0, truncated: false };
  const raw = diff.split("\n");
  // A trailing newline yields a final empty element that is not a line of the
  // file; drawing it adds a blank row to every diff.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  const lines: AgentstackDiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < raw.length && lines.length < DIFF_LINE_CAP; i += 1) {
    const line = raw[i] ?? "";
    let kind: AgentstackDiffLineKind;
    let text: string;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
      kind = "meta";
      text = line;
    } else if (line.startsWith("@@")) {
      kind = "hunk";
      text = line;
    } else if (line.startsWith("+")) {
      kind = "add";
      text = line.slice(1);
      additions += 1;
    } else if (line.startsWith("-")) {
      kind = "del";
      text = line.slice(1);
      deletions += 1;
    } else {
      kind = "context";
      // Context lines carry a leading space in unified format. Keeping it would
      // indent every unchanged line by one column relative to changed ones.
      text = line.startsWith(" ") ? line.slice(1) : line;
    }
    lines.push({ key: String(i), kind, text });
  }

  // Count the whole diff even when we stop drawing it: the header stat is a
  // claim about the change, not about how much of it fits on screen.
  for (let i = lines.length; i < raw.length; i += 1) {
    const line = raw[i] ?? "";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }

  return { lines, additions, deletions, truncated: raw.length > lines.length };
}
