import { describe, expect, it } from "vite-plus/test";

import {
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  matchAgentstackDenial,
  type AgentstackDoctorReport,
} from "./agentstack-logic";

const report: AgentstackDoctorReport = {
  errors: 0,
  warnings: 2,
  sections: [
    {
      title: "Drift",
      lines: [
        {
          level: "info",
          msg: "Claude Code    edited on disk since last apply ↳ review: agentstack diff",
        },
        { level: "warn", msg: "Codex CLI      2 change(s) pending ↳ agentstack apply --write" },
      ],
    },
    {
      title: "Zero-files gateway",
      lines: [
        { level: "ok", msg: "Claude Code    gateway registered (agentstack mcp)" },
        { level: "ok", msg: "Codex CLI      gateway registered (agentstack mcp)" },
        { level: "ok", msg: "this project is trusted for auto mode" },
      ],
    },
    { title: "Secrets", lines: [{ level: "ok", msg: "no secrets referenced" }] },
    {
      title: "Machine policy",
      lines: [
        { level: "ok", msg: 'restrictive — a rename-proof "*" rule constrains every server' },
      ],
    },
  ],
};

describe("deriveAgentstackOverviewRows", () => {
  it("maps doctor sections to curated rows and skips absent sections", () => {
    const rows = deriveAgentstackOverviewRows(report);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(byKey["manifest"]).toMatchObject({ level: "warn", summary: "1 change(s) pending" });
    expect(byKey["doctor"]).toMatchObject({ level: "warn" });
    expect(byKey["doctor"]!.summary).toContain("2 warning(s)");
    expect(byKey["gateway"]).toMatchObject({
      level: "ok",
      summary: "registered for 2 CLI(s) · project trusted",
    });
    expect(byKey["secrets"]).toMatchObject({ level: "ok", summary: "no secrets referenced" });
    // No "Skills" section in the fixture → no row invented for it.
    expect(byKey["skills"]).toBeUndefined();
  });

  it("degrades to no rows (plus the always-on doctor row) on empty input", () => {
    const rows = deriveAgentstackOverviewRows({ errors: 0, warnings: 0, sections: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "doctor", level: "ok", summary: "all checks pass" });
  });
});

describe("matchAgentstackDenial", () => {
  // Verbatim reason text produced by the guard (observed live on both
  // providers during the Phase 0 verification).
  const reason =
    'agentstack guard blocked this: /repo/.env: denied by [policy.filesystem] deny rule "!.env" (machine policy — ~/.agentstack/agentstack.toml)';

  it("recognizes a Claude tool.denied entry and extracts the parts", () => {
    const denial = matchAgentstackDenial({ label: "Tool denied: Read", detail: reason });
    expect(denial).toEqual({
      target: "/repo/.env",
      rule: "!.env",
      source: "machine policy",
    });
  });

  it("recognizes a failed tool call whose result text carries the guard message", () => {
    // Builtin tool calls in bypass mode fail with the guard text only in the
    // tool RESULT (surfaced as failureText); label/detail hold the input.
    const denial = matchAgentstackDenial({
      label: "Tool call",
      detail: 'Read: {"file_path":"/repo/.env"}',
      failureText: reason,
    });
    expect(denial).toEqual({ target: "/repo/.env", rule: "!.env", source: "machine policy" });
  });

  it("recognizes the Codex hook-block phrasing embedded in error text", () => {
    const denial = matchAgentstackDenial({
      label: "Command failed",
      detail: `Command blocked by PreToolUse hook: ${reason}. Command: cat .env`,
    });
    expect(denial?.target).toBe("/repo/.env");
    expect(denial?.rule).toBe("!.env");
  });

  it("returns null for unrelated denials and never throws on odd input", () => {
    expect(matchAgentstackDenial({ detail: "permission denied by user" })).toBeNull();
    expect(matchAgentstackDenial({})).toBeNull();
    // Marker present but unrecognized phrasing → still a card, raw target.
    const partial = matchAgentstackDenial({ detail: "AGENTSTACK GUARD BLOCKED something odd" });
    expect(partial).not.toBeNull();
  });
});

describe("deriveAgentstackActivityRows", () => {
  it("shows newest first, truncates guard labels, and formats age", () => {
    const now = 10_000;
    const rows = deriveAgentstackActivityRows(
      [
        { ts: now - 7_200, server: "figma", tool: "get_file", outcome: "ok" },
        {
          ts: now - 90,
          server: "host-guard",
          tool: `bash: ${"x".repeat(80)}`,
          outcome: "denied",
          run: "r-abc",
        },
      ],
      now,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outcome: "denied", age: "1m ago", run: "r-abc" });
    expect(rows[0]!.label.length).toBeLessThanOrEqual(48);
    expect(rows[0]!.label.endsWith("\u2026")).toBe(true);
    expect(rows[1]).toMatchObject({ outcome: "ok", label: "figma__get_file", age: "2h ago" });
  });
});
