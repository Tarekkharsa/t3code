import { describe, expect, it } from "vite-plus/test";

import {
  agentstackFeatureKnownMissing,
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  deriveAgentstackPolicyRows,
  deriveAgentstackProtectionRows,
  deriveAgentstackStatusChip,
  deriveAgentstackTrustBadge,
  deriveToolsetRows,
  deriveWorkflowCounts,
  deriveWorkflowStages,
  hasAgentstackFeature,
  matchAgentstackDenial,
  selectAgentstackUndoEntry,
  shortDigest,
  type AgentstackDoctorReport,
  type AgentstackRestoreEntryLike,
  type AgentstackWorkflowStepLike,
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
  it("maps real doctor sections to the beginner rows and opens a drift review on real drift", () => {
    const rows = deriveAgentstackOverviewRows(report);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    // A warn-level drift line is actionable → Manifest warns and opens the drift
    // review (adopt-vs-apply preview), never a single blind "apply" action.
    expect(byKey["manifest"]).toMatchObject({
      level: "warn",
      summary: "changes pending on disk",
      reviewDrift: true,
    });
    expect(byKey["manifest"]).not.toHaveProperty("action");
    // The beginner label for the doctor rollup is "Checkup".
    expect(byKey["doctor"]).toMatchObject({ level: "warn", label: "Checkup" });
    expect(byKey["doctor"]!.summary).toContain("2 warning(s)");
    expect(byKey["secrets"]).toMatchObject({ level: "ok", summary: "no secrets referenced" });
    // Guard/gateway/sandbox facts are protection-view rows, not beginner rows
    // (Stage 1.4): the overview names outcomes only.
    expect(byKey["gateway"]).toBeUndefined();
    expect(byKey["guard"]).toBeUndefined();
    expect(byKey["sandbox"]).toBeUndefined();
  });

  it("treats info-only (foreign-kept) drift as in-sync, not a no-op 'fix' button", () => {
    // The real-world case that made the old button do nothing: the only drift
    // lines are `info` (servers another setup applied, kept on disk). This
    // project renders cleanly, so the Manifest row stays "ok" but still opens
    // the review so the user can see/manage the kept servers.
    const foreignOnly: AgentstackDoctorReport = {
      errors: 0,
      warnings: 0,
      sections: [
        {
          title: "Drift",
          lines: [
            {
              level: "info",
              msg: "Claude Code    would REMOVE figma, miro ↳ keep them: agentstack adopt --scope global · prune them: agentstack apply --prune-foreign --scope global",
            },
          ],
        },
      ],
    };
    const byKey = Object.fromEntries(
      deriveAgentstackOverviewRows(foreignOnly).map((r) => [r.key, r]),
    );
    expect(byKey["manifest"]).toMatchObject({
      level: "ok",
      summary: "in sync here · other setups' servers kept",
      reviewDrift: true,
    });
    expect(byKey["manifest"]).not.toHaveProperty("action");
  });

  it("degrades to the checkup row alone on an empty report", () => {
    const rows = deriveAgentstackOverviewRows({ errors: 0, warnings: 0, sections: [] });
    expect(rows.map((r) => r.key)).toEqual(["doctor"]);
    expect(rows[0]).toMatchObject({ key: "doctor", level: "ok", summary: "all checks pass" });
  });
});

describe("deriveAgentstackProtectionRows", () => {
  it("reads live guard/machine-policy/gateway state and labels every tier with cost and coverage", () => {
    const withGuard: AgentstackDoctorReport = {
      ...report,
      sections: [
        ...report.sections,
        {
          title: "t3code (supervisor)",
          lines: [{ level: "warn", msg: "guard hooks do not cover the detected providers" }],
        },
      ],
    };
    const rows = deriveAgentstackProtectionRows(withGuard);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    // Guard off → actionable enable, honestly labelled free.
    expect(byKey["guard"]).toMatchObject({ level: "warn", action: "guard-install" });
    expect(byKey["guard"]!.summary).toContain("off");
    // A configured machine policy is the ceiling — its posture word surfaces.
    expect(byKey["machine-policy"]!.summary).toContain("restrictive");
    expect(byKey["machine-policy"]!.cost).toContain("no repo or UI can loosen");
    // Registered gateway → live serving on, with the inert-until-reviewed fact.
    expect(byKey["gateway"]).toMatchObject({ level: "ok", label: "Live serving" });
    expect(byKey["gateway"]!.summary).toContain("stay inert");
    // Standing run tiers never claim to be active and name their real costs.
    expect(byKey["locked-run"]).toMatchObject({ level: "muted" });
    expect(byKey["locked-run"]!.cost).toContain("not kernel isolation");
    expect(byKey["sandbox"]).toMatchObject({ level: "muted" });
    expect(byKey["sandbox"]!.cost).toContain("needs Docker");
  });

  it("shows an unconfigured machine policy as a fact with the exact place to add one", () => {
    const unconfigured: AgentstackDoctorReport = {
      errors: 0,
      warnings: 0,
      sections: [
        {
          title: "Machine policy",
          lines: [
            {
              level: "ok",
              msg: "unconfigured — no machine policy file — projects use their own policy",
            },
          ],
        },
      ],
    };
    const rows = deriveAgentstackProtectionRows(unconfigured);
    const machine = rows.find((r) => r.key === "machine-policy");
    expect(machine).toMatchObject({ level: "muted" });
    expect(machine!.summary).toContain("none");
    expect(machine!.cost).toContain("~/.agentstack/agentstack.toml");
  });
});

describe("deriveAgentstackTrustBadge", () => {
  it("prefers the structured trust state over gateway prose", () => {
    // Structured field wins even when prose would say otherwise.
    const drifted: AgentstackDoctorReport = {
      errors: 0,
      warnings: 0,
      trust: "drifted",
      sections: [
        { title: "Zero-files gateway", lines: [{ level: "ok", msg: "trusted for auto mode" }] },
      ],
    };
    expect(deriveAgentstackTrustBadge(drifted).state).toBe("drifted");
    expect(deriveAgentstackTrustBadge({ ...drifted, trust: "untrusted" }).state).toBe("inert");
    expect(deriveAgentstackTrustBadge({ ...drifted, trust: "trusted" }).state).toBe("trusted");
  });

  it("reads trusted / inert / unknown from the gateway section", () => {
    expect(deriveAgentstackTrustBadge(report).state).toBe("trusted");
    const inert: AgentstackDoctorReport = {
      errors: 0,
      warnings: 0,
      sections: [
        {
          title: "Zero-files gateway",
          lines: [{ level: "warn", msg: "not trusted for auto mode" }],
        },
      ],
    };
    expect(deriveAgentstackTrustBadge(inert).state).toBe("inert");
    expect(deriveAgentstackTrustBadge({ errors: 0, warnings: 0, sections: [] }).state).toBe(
      "unknown",
    );
  });
});

describe("deriveAgentstackStatusChip", () => {
  it("derives one chip per state and Protected only when both protections are on", () => {
    expect(deriveAgentstackStatusChip({ state: "needs_setup" })).toMatchObject({
      label: "Needs setup",
      isProtected: false,
    });
    expect(deriveAgentstackStatusChip({ state: "needs_attention" })).toMatchObject({
      label: "Needs attention",
      level: "warn",
    });
    // Ready without both protections is just "Ready".
    expect(
      deriveAgentstackStatusChip({
        state: "ready",
        protection: { guard: true, machine_policy: false },
      }),
    ).toMatchObject({ label: "Ready", isProtected: false });
    expect(
      deriveAgentstackStatusChip({
        state: "ready",
        protection: { guard: false, machine_policy: true },
      }),
    ).toMatchObject({ label: "Ready", isProtected: false });
    expect(deriveAgentstackStatusChip({ state: "ready" })).toMatchObject({ label: "Ready" });
    // Only guard AND machine_policy earns "Protected".
    expect(
      deriveAgentstackStatusChip({
        state: "ready",
        protection: { guard: true, machine_policy: true },
      }),
    ).toMatchObject({ label: "Protected", level: "ok", isProtected: true });
    // Absent/unknown state → no chip (caller falls back to the row rollup).
    expect(deriveAgentstackStatusChip({})).toBeNull();
    expect(deriveAgentstackStatusChip({ state: "something-new" })).toBeNull();
  });
});

describe("feature gating", () => {
  it("reports whether a contract is usable, defaulting an absent list to unusable", () => {
    expect(hasAgentstackFeature(["apply-setup", "restore-last"], "apply-setup")).toBe(true);
    expect(hasAgentstackFeature(["apply-setup"], "restore-last")).toBe(false);
    // Absent/empty (older CLI) → newer-only contracts are treated as unusable.
    expect(hasAgentstackFeature(undefined, "apply-setup")).toBe(false);
    expect(hasAgentstackFeature([], "apply-setup")).toBe(false);
  });

  it("only reports a contract as known-missing when the CLI advertised its features", () => {
    // Known list that omits it → known-missing (add the extra gate).
    expect(agentstackFeatureKnownMissing(["apply-setup"], "trust-consent")).toBe(true);
    // Present → not missing.
    expect(agentstackFeatureKnownMissing(["trust-consent"], "trust-consent")).toBe(false);
    // Unknown/empty (older CLI) → NOT known-missing, so no extra gate is added
    // and the existing digest gate stands on its own.
    expect(agentstackFeatureKnownMissing([], "trust-consent")).toBe(false);
    expect(agentstackFeatureKnownMissing(undefined, "trust-consent")).toBe(false);
  });
});

describe("selectAgentstackUndoEntry", () => {
  const entry = (over: Partial<AgentstackRestoreEntryLike>): AgentstackRestoreEntryLike => ({
    id: "a".repeat(16),
    time_unix: 1_000,
    scope: "project",
    summary: "1 file",
    undone: false,
    touches_project: true,
    ...over,
  });

  it("picks the newest project-touching, not-yet-undone entry", () => {
    const chosen = selectAgentstackUndoEntry([
      entry({ id: "old", time_unix: 100 }),
      entry({ id: "newest", time_unix: 300 }),
      entry({ id: "mid", time_unix: 200 }),
    ]);
    expect(chosen?.id).toBe("newest");
  });

  it("skips already-undone and non-project entries", () => {
    const chosen = selectAgentstackUndoEntry([
      entry({ id: "undone", time_unix: 900, undone: true }),
      entry({ id: "other-project", time_unix: 800, touches_project: false }),
      entry({ id: "safe", time_unix: 500 }),
    ]);
    expect(chosen?.id).toBe("safe");
  });

  it("returns null when nothing is safe to undo here", () => {
    expect(selectAgentstackUndoEntry([])).toBeNull();
    expect(
      selectAgentstackUndoEntry([entry({ touches_project: false }), entry({ undone: true })]),
    ).toBeNull();
  });
});

describe("deriveAgentstackPolicyRows", () => {
  it("emits machine-policy lines with the fix tail stripped", () => {
    const rows = deriveAgentstackPolicyRows(report);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Machine policy", level: "ok" });
    expect(rows[0]!.msg).toContain("rename-proof");
  });
});

describe("workflow derivations", () => {
  const steps: AgentstackWorkflowStepLike[] = [
    {
      step: 1,
      role: "reader",
      label: "map:a.ts",
      state: "completed",
      tool_calls: 12,
      duration_ms: 34000,
    },
    { step: 2, role: "reader", label: "map:b.ts", state: "running" },
    { step: 3, role: "writer", label: "reduce:synth", state: "spawned" },
  ];

  it("groups steps into labelled stages in MAP/REDUCE/VERIFY order", () => {
    const { stages, labelled } = deriveWorkflowStages(steps);
    expect(labelled).toBe(true);
    expect(stages.map((s) => s.title)).toEqual(["MAP", "REDUCE"]);
    expect(stages[0]!.steps).toHaveLength(2);
  });

  it("falls back to a single STEPS stage when labels lack a known prefix", () => {
    const { stages, labelled } = deriveWorkflowStages([
      { step: 1, role: "reader", state: "running" },
    ]);
    expect(labelled).toBe(false);
    expect(stages.map((s) => s.title)).toEqual(["STEPS"]);
  });

  it("counts done vs running and never guesses queued", () => {
    expect(deriveWorkflowCounts(steps)).toEqual({ done: 1, running: 2, total: 3 });
  });

  it("shortens a pinned digest", () => {
    expect(shortDigest("sha256:9f2cabcdef0011e1")).toBe("sha256:9f2c…e1");
    expect(shortDigest(undefined)).toBeUndefined();
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
      dimension: "filesystem",
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
    expect(denial).toEqual({
      target: "/repo/.env",
      rule: "!.env",
      source: "machine policy",
      dimension: "filesystem",
    });
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

describe("deriveToolsetRows", () => {
  const dev = {
    name: "dev",
    servers: ["github", "tldraw"],
    skills: ["review"],
    harness: "codex",
    pinned: true,
    active: false,
    blockers: [],
  };
  const stale = {
    name: "stale",
    servers: ["github"],
    skills: [],
    pinned: false,
    blockers: [{ name: "github", reason: "unpinned — run `agentstack lock`" }],
  };

  it("summarizes counts and harness, and marks pinned+trusted rows ready", () => {
    const rows = deriveToolsetRows([dev, stale], "trusted");
    expect(rows[0]).toMatchObject({
      name: "dev",
      summary: "2 servers · 1 skill · for codex",
      ready: true,
      active: false,
      blockedBecause: null,
    });
    // A blocked row surfaces its first blocker's actionable reason.
    expect(rows[1]).toMatchObject({ name: "stale", ready: false });
    expect(rows[1]!.blockedBecause).toContain("agentstack lock");
  });

  it("blocks every row on an untrusted or drifted project with the review pointer", () => {
    for (const trust of ["untrusted", "drifted"]) {
      const rows = deriveToolsetRows([dev], trust);
      expect(rows[0]!.ready).toBe(false);
      expect(rows[0]!.blockedBecause).toContain("review this project");
    }
  });

  it("marks the in-use row active (absent field on an older CLI reads inactive)", () => {
    const rows = deriveToolsetRows([{ ...dev, active: true }, stale], "trusted");
    expect(rows[0]!.active).toBe(true);
    expect(rows[1]!.active).toBe(false);
  });
});
