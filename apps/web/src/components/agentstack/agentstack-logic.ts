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

export interface AgentstackDoctorReport {
  errors: number;
  warnings: number;
  sections: ReadonlyArray<AgentstackDoctorSection>;
}

/** `muted` = a grey "not a fault, just a fact" dot (e.g. an available capability). */
export type AgentstackRowLevel = "ok" | "warn" | "error" | "muted";

export interface AgentstackOverviewRow {
  key: string;
  label: string;
  summary: string;
  level: AgentstackRowLevel;
  /** A vetted governed action this row can trigger (fix drift, enable guard). */
  action?: AgentstackActionKind;
}

/** The vetted, server-enumerated CLI actions the panel may trigger. */
export type AgentstackActionKind = "apply" | "guard-install";

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
 * Curated mapping from real doctor sections to the design's overview rows.
 * Each row is sourced from actual doctor output — rows we cannot source
 * honestly are omitted rather than filled with invented numbers, so the panel
 * stays truthful across agentstack versions. `workflowRow` is supplied
 * separately by the caller from the workflow feed (doctor doesn't carry it).
 */
export function deriveAgentstackOverviewRows(
  report: AgentstackDoctorReport,
  workflowRow?: AgentstackOverviewRow,
): AgentstackOverviewRow[] {
  const rows: AgentstackOverviewRow[] = [];

  // Manifest ← Drift section. Drift lines are `info`-level facts, so "pending"
  // means any non-ok line, not just warn/error.
  const drift = sectionByTitle(report, "Drift");
  if (drift) {
    const hasDrift = drift.lines.some((l) => l.level !== "ok");
    const cliCount = sectionByTitle(report, "Adapters & CLIs")?.lines.filter(
      (l) => l.level === "ok",
    ).length;
    rows.push({
      key: "manifest",
      label: "Manifest",
      summary: hasDrift
        ? "changes pending on disk"
        : `in sync${cliCount ? ` · rendered to ${cliCount} CLIs` : ""}`,
      level: hasDrift ? "warn" : "ok",
      ...(hasDrift ? { action: "apply" as const } : {}),
    });
  }

  rows.push({
    key: "doctor",
    label: "Doctor",
    summary:
      report.errors === 0 && report.warnings === 0
        ? "all checks pass"
        : [
            report.errors > 0 ? `${report.errors} error(s)` : null,
            report.warnings > 0 ? `${report.warnings} warning(s)` : null,
          ]
            .filter(Boolean)
            .join(" · ") + " — each names its fix",
    level: report.errors > 0 ? "error" : report.warnings > 0 ? "warn" : "ok",
  });

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
        ? "hooks cover the detected providers"
        : "not enabled — sessions run ungated",
      level: enabled ? "ok" : "warn",
      ...(enabled ? {} : { action: "guard-install" as const }),
    });
  }

  const gateway = sectionByTitle(report, "Zero-files gateway");
  if (gateway) {
    const registered = gateway.lines.filter(
      (l) => l.level === "ok" && l.msg.includes("gateway registered"),
    ).length;
    const trusted = gateway.lines.some((l) => l.msg.includes("trusted for auto mode"));
    rows.push({
      key: "gateway",
      label: "Gateway",
      summary:
        registered > 0
          ? `connected · ${registered} CLI(s)${trusted ? " · trusted" : ""}`
          : "not registered",
      level: worstLevel(gateway),
    });
  }

  const secrets = sectionByTitle(report, "Secrets");
  if (secrets) {
    rows.push({
      key: "secrets",
      label: "Secrets",
      summary: firstMessage(secrets) ?? "—",
      level: worstLevel(secrets),
    });
  }

  // Library ← Skills section (the manifest's library-backed capabilities).
  const skills = sectionByTitle(report, "Skills");
  if (skills) {
    rows.push({
      key: "library",
      label: "Library",
      summary: firstMessage(skills) ?? "—",
      level: worstLevel(skills),
    });
  }

  // Sandbox is a standing capability of the binary, not a doctor finding — a
  // grey "available" fact, matching the design's muted Sandbox row.
  rows.push({
    key: "sandbox",
    label: "Sandbox",
    summary: "run --sandbox --lockdown available",
    level: "muted",
  });

  if (workflowRow) rows.push(workflowRow);

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

// ── policy tab ───────────────────────────────────────────────────────────────

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

  return {
    target: target || "(command withheld)",
    ...(rule ? { rule } : {}),
    ...(source ? { source } : {}),
  };
}
