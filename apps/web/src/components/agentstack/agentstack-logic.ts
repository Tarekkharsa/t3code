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

export type AgentstackRowLevel = "ok" | "warn" | "error";

export interface AgentstackOverviewRow {
  key: string;
  label: string;
  summary: string;
  level: AgentstackRowLevel;
}

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

/** Count lines that are actionable (doctor's `info` lines are facts, not faults). */
function actionableCount(section: AgentstackDoctorSection): number {
  return section.lines.filter((l) => l.level === "warn" || l.level === "error").length;
}

/**
 * Curated mapping from doctor sections to the panel's overview rows. Only
 * rows whose backing section exists are emitted, so the panel stays honest
 * across agentstack versions (older/newer CLIs may lack a section).
 */
export function deriveAgentstackOverviewRows(
  report: AgentstackDoctorReport,
): AgentstackOverviewRow[] {
  const rows: AgentstackOverviewRow[] = [];

  const drift = sectionByTitle(report, "Drift");
  if (drift) {
    const pending = actionableCount(drift);
    rows.push({
      key: "manifest",
      label: "Manifest",
      summary: pending === 0 ? "in sync" : `${pending} change(s) pending`,
      level: worstLevel(drift),
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
          ? `registered for ${registered} CLI(s)${trusted ? " · project trusted" : ""}`
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

  const policy = sectionByTitle(report, "Machine policy");
  if (policy) {
    rows.push({
      key: "policy",
      label: "Policy",
      summary: firstMessage(policy) ?? "—",
      level: worstLevel(policy),
    });
  }

  const skills = sectionByTitle(report, "Skills");
  if (skills) {
    rows.push({
      key: "skills",
      label: "Skills",
      summary: firstMessage(skills) ?? "—",
      level: worstLevel(skills),
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
