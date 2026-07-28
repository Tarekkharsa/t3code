import { describe, expect, it } from "vite-plus/test";

import {
  AGENTSTACK_FINDINGS_PREVIEW,
  agentstackFeatureKnownMissing,
  agentstackFindingAction,
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  deriveAgentstackPolicyRows,
  deriveAgentstackProtectionRows,
  deriveAgentstackStatusChip,
  deriveAgentstackFindings,
  deriveAgentstackShareFacts,
  deriveAgentstackTrustBadge,
  deriveToolsetRows,
  deriveWorkflowCounts,
  deriveWorkflowStages,
  filterAgentstackLibraryItems,
  formatAgentstackCheckupSummary,
  formatAgentstackCount,
  formatAgentstackImportSummary,
  hasAgentstackFeature,
  matchAgentstackDenial,
  matchAgentstackNextAction,
  partitionAgentstackOverviewRows,
  selectAgentstackFindingsView,
  selectAgentstackPrimaryConcern,
  shortenAgentstackPath,
  shortenAgentstackPathsIn,
  selectAgentstackUndoEntry,
  shortDigest,
  summarizeAgentstackHealthyRows,
  type AgentstackDoctorReport,
  type AgentstackFinding,
  type AgentstackOverviewRow,
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
    expect(byKey["doctor"]!.summary).toContain("2 warnings");
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

describe("shortenAgentstackPath", () => {
  const ctx = { root: "/Users/ada/proj", home: "/Users/ada" };

  it("makes a path inside the project relative to its root", () => {
    expect(shortenAgentstackPath("/Users/ada/proj/.mcp.json", ctx)).toBe(".mcp.json");
    expect(shortenAgentstackPath("/Users/ada/proj/.codex/config.toml", ctx)).toBe(
      ".codex/config.toml",
    );
  });

  it("prefers the project root over home for a project inside home", () => {
    expect(shortenAgentstackPath("/Users/ada/proj/a.json", ctx)).toBe("a.json");
  });

  it("collapses home for a path outside the project", () => {
    expect(shortenAgentstackPath("/Users/ada/.claude.json", ctx)).toBe("~/.claude.json");
  });

  it("leaves a path outside both untouched — the whole path is the information", () => {
    expect(shortenAgentstackPath("/opt/homebrew/bin/node", ctx)).toBe("/opt/homebrew/bin/node");
  });

  it("never returns an empty string for the root itself", () => {
    expect(shortenAgentstackPath("/Users/ada/proj", ctx)).toBe("~/proj");
  });

  it("tolerates a trailing separator and a missing context", () => {
    expect(shortenAgentstackPath("/Users/ada/proj/x", { root: "/Users/ada/proj/" })).toBe("x");
    expect(shortenAgentstackPath("/Users/ada/x", {})).toBe("/Users/ada/x");
  });

  it("does not shorten a sibling directory that merely shares a prefix", () => {
    expect(shortenAgentstackPath("/Users/ada/proj-other/x", ctx)).toBe("~/proj-other/x");
  });
});

describe("shortenAgentstackPathsIn", () => {
  const ctx = { root: "/Users/ada/proj", home: "/Users/ada" };

  it("shortens every absolute path inside a launch command", () => {
    expect(
      shortenAgentstackPathsIn("/Users/ada/.nvm/bin/node /Users/ada/proj/dist/index.js", ctx),
    ).toBe("~/.nvm/bin/node dist/index.js");
  });

  it("leaves quoting and shell syntax alone", () => {
    expect(shortenAgentstackPathsIn("sh -c cd '/Users/ada/x' && exec node", ctx)).toBe(
      "sh -c cd '~/x' && exec node",
    );
  });

  it("leaves a bare launcher and its flags untouched", () => {
    expect(shortenAgentstackPathsIn("npx -y chrome-devtools-mcp@latest", ctx)).toBe(
      "npx -y chrome-devtools-mcp@latest",
    );
  });

  it("does not mangle a URL", () => {
    expect(shortenAgentstackPathsIn("https://mcp.figma.com/mcp", ctx)).toBe(
      "https://mcp.figma.com/mcp",
    );
  });
});

describe("matchAgentstackNextAction", () => {
  it("maps the recommendations the panel can actually run", () => {
    expect(matchAgentstackNextAction("agentstack guard install")).toBe("guard-install");
    expect(matchAgentstackNextAction("agentstack apply --write")).toBe("apply-project");
  });

  it("tolerates surrounding and repeated whitespace", () => {
    expect(matchAgentstackNextAction("  agentstack   guard  install ")).toBe("guard-install");
  });

  it("keeps scopes distinct — the global apply maps to the global action", () => {
    expect(matchAgentstackNextAction("agentstack apply --write --scope global")).toBe(
      "apply-global",
    );
    expect(matchAgentstackNextAction("agentstack apply --write")).toBe("apply-project");
  });

  it("refuses a scope it has no exact action for", () => {
    expect(
      matchAgentstackNextAction("agentstack apply --write --scope project --target codex"),
    ).toBeNull();
  });

  it("returns null for anything it does not exactly recognize", () => {
    expect(matchAgentstackNextAction("agentstack trust .")).toBeNull();
    expect(matchAgentstackNextAction("agentstack secret set GH_PAT")).toBeNull();
    expect(matchAgentstackNextAction("agentstack apply")).toBeNull();
    expect(matchAgentstackNextAction(null)).toBeNull();
    expect(matchAgentstackNextAction("")).toBeNull();
  });
});

describe("filterAgentstackLibraryItems", () => {
  const items = [
    { name: "pg-tools", detail: "Postgres helpers" },
    { name: "rust-testing", detail: "Rust testing patterns" },
    { name: "figma", detail: null },
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(filterAgentstackLibraryItems(items, "")).toHaveLength(3);
    expect(filterAgentstackLibraryItems(items, "   ")).toHaveLength(3);
  });

  it("matches on name, case-insensitively", () => {
    expect(filterAgentstackLibraryItems(items, "RUST").map((i) => i.name)).toEqual([
      "rust-testing",
    ]);
  });

  it("matches on detail, so a description finds what the name does not", () => {
    expect(filterAgentstackLibraryItems(items, "postgres").map((i) => i.name)).toEqual([
      "pg-tools",
    ]);
  });

  it("tolerates a null detail", () => {
    expect(filterAgentstackLibraryItems(items, "figma").map((i) => i.name)).toEqual(["figma"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterAgentstackLibraryItems(items, "kubernetes")).toHaveLength(0);
  });
});

describe("deriveAgentstackShareFacts", () => {
  const report = (
    sections: Array<{ title: string; lines: Array<{ level: string; msg: string }> }>,
  ) => ({ sections }) as never;

  it("counts the secret references that travel as placeholders", () => {
    const facts = deriveAgentstackShareFacts(
      report([
        {
          title: "Secrets",
          lines: [
            { level: "ok", msg: "A resolved from keychain" },
            { level: "ok", msg: "B resolved from keychain" },
          ],
        },
      ]),
    );
    expect(facts.secretRefs).toBe(2);
  });

  it("surfaces the reproducibility line as doctor reported it", () => {
    const facts = deriveAgentstackShareFacts(
      report([{ title: "Reproducibility", lines: [{ level: "warn", msg: "1 skill drifted" }] }]),
    );
    expect(facts.pinning).toEqual({ level: "warn", msg: "1 skill drifted" });
  });

  it("is empty and safe without a report or without those sections", () => {
    expect(deriveAgentstackShareFacts(null)).toEqual({ secretRefs: 0, pinning: null });
    expect(deriveAgentstackShareFacts(report([]))).toEqual({ secretRefs: 0, pinning: null });
  });
});

describe("partitionAgentstackOverviewRows", () => {
  const row = (over: Record<string, unknown>) =>
    ({ key: "k", label: "L", summary: "s", level: "ok", ...over }) as never;

  it("treats errors and warnings as problems", () => {
    const { problems, healthy } = partitionAgentstackOverviewRows([
      row({ key: "a", level: "error" }),
      row({ key: "b", level: "warn" }),
      row({ key: "c", level: "ok" }),
    ]);
    expect(problems.map((r) => r.key)).toEqual(["a", "b"]);
    expect(healthy.map((r) => r.key)).toEqual(["c"]);
  });

  it("never collapses a row that has an affordance, even when it reads ok", () => {
    const { problems, healthy } = partitionAgentstackOverviewRows([
      row({ key: "drift", level: "ok", reviewDrift: true }),
      row({ key: "act", level: "ok", action: "apply-project" }),
      row({ key: "quiet", level: "ok" }),
    ]);
    expect(problems.map((r) => r.key)).toEqual(["drift", "act"]);
    expect(healthy.map((r) => r.key)).toEqual(["quiet"]);
  });

  it("handles all-healthy and all-problem sets", () => {
    expect(partitionAgentstackOverviewRows([]).problems).toHaveLength(0);
    const allOk = partitionAgentstackOverviewRows([row({ key: "a" }), row({ key: "b" })]);
    expect(allOk.problems).toHaveLength(0);
    expect(allOk.healthy).toHaveLength(2);
  });
});

describe("deriveAgentstackFindings", () => {
  const report = (sections: unknown) => ({ sections }) as never;

  it("splits doctor's `message ↳ fix` and maps a runnable fix to its action", () => {
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "Drift",
          lines: [
            { level: "warn", msg: "Codex CLI 10 change(s) pending ↳ agentstack apply --write" },
          ],
        },
      ]),
    );
    expect(f?.message).toBe("Codex CLI 10 change(s) pending");
    expect(f?.fix).toBe("agentstack apply --write");
    expect(f?.action).toBe("apply-project");
    expect(f?.section).toBe("Drift");
  });

  it("maps the explicitly global apply to the global action", () => {
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "Drift",
          lines: [{ level: "warn", msg: "x ↳ agentstack apply --write --scope global" }],
        },
      ]),
    );
    expect(f?.action).toBe("apply-global");
  });

  it("keeps a finding with no fix, and offers no action for one it cannot run", () => {
    const found = deriveAgentstackFindings(
      report([
        {
          title: "Adapters & CLIs",
          lines: [
            { level: "warn", msg: "VS Code config present but binary not on PATH" },
            { level: "warn", msg: "needs review ↳ agentstack trust ." },
          ],
        },
      ]),
    );
    expect(found[0]?.fix).toBeNull();
    expect(found[0]?.action).toBeNull();
    expect(found[1]?.fix).toBe("agentstack trust .");
    expect(found[1]?.action).toBeNull();
  });

  it("ignores ok and info lines, and survives a missing report", () => {
    expect(
      deriveAgentstackFindings(
        report([
          {
            title: "S",
            lines: [
              { level: "ok", msg: "fine" },
              { level: "info", msg: "fyi" },
            ],
          },
        ]),
      ),
    ).toHaveLength(0);
    expect(deriveAgentstackFindings(null)).toHaveLength(0);
  });

  it("bounds a doctor line built out of repository-controlled text", () => {
    // Doctor interpolates manifest skill/server names, fragment names and
    // paths verbatim, and this list is the one place a line reaches the DOM
    // whole. All repository content is hostile input: React escapes it, but a
    // 200 KB "skill name" would still own the panel.
    const hostile = "A".repeat(200_000);
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "Skills",
          lines: [
            { level: "warn", msg: `${hostile} not installed ↳ agentstack install ${hostile}` },
          ],
        },
      ]),
    );
    expect(f?.message.length).toBeLessThanOrEqual(240);
    expect(f?.fix?.length).toBeLessThanOrEqual(240);
    expect(f?.message.endsWith("…")).toBe(true);
  });

  it("matches the action on the whole command, not on the clipped one", () => {
    // Clipping is a display concern; a fix that is one of our fixed actions
    // must still map to it however long the line that carried it was.
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "t3code (supervisor)",
          lines: [{ level: "warn", msg: `${"B".repeat(500)} ↳ agentstack guard install` }],
        },
      ]),
    );
    expect(f?.action).toBe("guard-install");
  });
});

describe("formatAgentstackCheckupSummary", () => {
  it("pluralizes each count and keeps the promise that every finding names a fix", () => {
    expect(formatAgentstackCheckupSummary(1, 7)).toBe("1 error · 7 warnings — each names its fix");
    expect(formatAgentstackCheckupSummary(2, 1)).toBe("2 errors · 1 warning — each names its fix");
  });

  it("names only the level that exists, and says nothing is wrong when nothing is", () => {
    expect(formatAgentstackCheckupSummary(0, 1)).toBe("1 warning — each names its fix");
    expect(formatAgentstackCheckupSummary(3, 0)).toBe("3 errors — each names its fix");
    expect(formatAgentstackCheckupSummary(0, 0)).toBe("all checks pass");
  });
});

describe("summarizeAgentstackHealthyRows", () => {
  const row = (over: Partial<AgentstackOverviewRow>): AgentstackOverviewRow => ({
    key: "k",
    label: "L",
    summary: "s",
    level: "ok",
    ...over,
  });

  it("states the outcome each row established, not our category names", () => {
    expect(
      summarizeAgentstackHealthyRows([
        row({ key: "manifest", label: "Manifest", healthy: "4 CLIs in sync" }),
        row({ key: "doctor", label: "Checkup", summary: "all checks pass" }),
        row({ key: "secrets", label: "Secrets", healthy: "secrets resolved" }),
        row({ key: "library", label: "Library", healthy: "skills installed" }),
      ]),
    ).toBe("4 CLIs in sync · secrets resolved · skills installed");
  });

  it("leaves the readiness claim to the chip and never restates it", () => {
    // The chip directly above says Ready/Protected from the same doctor state;
    // "checks pass" beside it is the same sentence twice.
    expect(summarizeAgentstackHealthyRows([row({ key: "doctor", label: "Checkup" })])).toBeNull();
  });

  it("names a row that established no specific claim instead of inventing one", () => {
    // No `healthy` — e.g. clean-at-rest, where nothing was rendered and drift
    // was never compared, so there is no count of CLIs "in sync" to report.
    expect(
      summarizeAgentstackHealthyRows([
        row({ key: "manifest", label: "Manifest", summary: "in sync · rendered to 3 CLIs" }),
        row({ key: "future", label: "Attestation", summary: "whatever" }),
      ]),
    ).toBe("manifest ok · attestation ok");
  });

  it("drops a row that is fine but has nothing worth saying", () => {
    expect(
      summarizeAgentstackHealthyRows([
        row({ key: "secrets", label: "Secrets", healthy: "no secrets needed" }),
        // `null` = "no skills defined": a healthy nothing, so it earns no phrase.
        row({ key: "library", label: "Library", healthy: null }),
      ]),
    ).toBe("no secrets needed");
  });

  it("produces no line at all for an empty or wholly silent set", () => {
    expect(summarizeAgentstackHealthyRows([])).toBeNull();
    expect(
      summarizeAgentstackHealthyRows([row({ key: "library", label: "Library", healthy: null })]),
    ).toBeNull();
  });
});

/**
 * The end-to-end path the reassurance line actually travels: a real doctor
 * payload → rows → partition → one line. Asserting on hand-built rows alone
 * left the two ends free to drift apart, which is how the line came to claim
 * "N CLIs in sync" for a project that renders to none.
 */
describe("the healthy line, from a real doctor report", () => {
  const lineFor = (report: AgentstackDoctorReport): string | null =>
    summarizeAgentstackHealthyRows(
      partitionAgentstackOverviewRows(deriveAgentstackOverviewRows(report)).healthy,
    );

  const adapters = {
    title: "Adapters & CLIs",
    lines: [
      { level: "ok", msg: "Claude Code    installed · ~/.claude.json parses" },
      { level: "ok", msg: "Codex CLI      installed · ~/.codex/config.toml parses" },
      { level: "ok", msg: "Cursor         installed · ~/.cursor/mcp.json parses" },
      { level: "info", msg: "OpenCode       not detected (ok unless you use it)" },
    ],
  };

  it("claims the CLI count only where doctor compared the renders", () => {
    expect(
      lineFor({
        errors: 0,
        warnings: 0,
        sections: [
          adapters,
          { title: "Drift", lines: [{ level: "ok", msg: "all targets in sync" }] },
          {
            title: "Secrets",
            lines: [{ level: "ok", msg: "GITHUB_TOKEN resolved from keychain" }],
          },
        ],
      }),
    ).toBe("3 CLIs in sync · secrets resolved");
  });

  it("claims nothing about sync in clean-at-rest, where nothing was rendered", () => {
    // `--skip-drift`: the section is Ok and warning-free precisely BECAUSE the
    // comparison never ran. "3 CLIs in sync" here would reassure the user about
    // a render they deliberately turned off.
    const line = lineFor({
      errors: 0,
      warnings: 0,
      sections: [
        adapters,
        {
          title: "Drift",
          lines: [
            { level: "ok", msg: "not rendering configs — clean-at-rest keeps them off disk" },
          ],
        },
        { title: "Secrets", lines: [{ level: "ok", msg: "no secrets referenced" }] },
      ],
    });
    expect(line).toBe("manifest ok · no secrets needed");
    expect(line).not.toContain("in sync");
  });

  it("reads secrets off the whole section, not off the clipped row summary", () => {
    // A ref name long enough to push "resolved from" past the row's 64-char
    // clamp used to degrade the phrase to a bare "secrets ok".
    expect(
      lineFor({
        errors: 0,
        warnings: 0,
        sections: [
          {
            title: "Secrets",
            lines: [
              {
                level: "ok",
                msg: `${"SOME_VERY_LONG_SECRET_REF_NAME".padEnd(48)} resolved from keychain`,
              },
            ],
          },
        ],
      }),
    ).toBe("secrets resolved");
  });
});

describe("selectAgentstackFindingsView", () => {
  const finding = (over: Partial<AgentstackFinding>): AgentstackFinding => ({
    key: "k",
    level: "warn",
    message: "m",
    fix: null,
    action: null,
    section: "S",
    ...over,
  });
  const many = Array.from({ length: 5 }, (_, i) => finding({ key: `w${i}` }));
  const keys = (view: { visible: ReadonlyArray<{ finding: AgentstackFinding }> }) =>
    view.visible.map((v) => v.finding.key);

  it("shows an ordinary report whole — the cap is for pathological ones", () => {
    const view = selectAgentstackFindingsView(many, false, ["status-v1"]);
    expect(keys(view)).toEqual(["w0", "w1", "w2", "w3", "w4"]);
    expect(view).toMatchObject({ hidden: 0, total: 5 });
  });

  it("caps a long list and reports how many stay hidden", () => {
    const forty = Array.from({ length: 40 }, (_, i) => finding({ key: `w${i}` }));
    const view = selectAgentstackFindingsView(forty, false, ["status-v1"]);
    expect(view).toMatchObject({ hidden: 32, total: 40 });
    expect(view.visible).toHaveLength(AGENTSTACK_FINDINGS_PREVIEW);
  });

  it("reveals everything once expanded", () => {
    const view = selectAgentstackFindingsView(many, true, ["status-v1"], 2);
    expect(view.visible).toHaveLength(5);
    expect(view.hidden).toBe(0);
  });

  it("never buries an error behind the preview, and keeps report order within a level", () => {
    const view = selectAgentstackFindingsView(
      [
        finding({ key: "w0" }),
        finding({ key: "w1" }),
        finding({ key: "w2" }),
        finding({ key: "e0", level: "error" }),
        finding({ key: "w3" }),
      ],
      false,
      ["status-v1"],
      3,
    );
    expect(keys(view)).toEqual(["e0", "w0", "w1"]);
    expect(view.hidden).toBe(2);
  });

  it("hides nothing when there is nothing to hide", () => {
    expect(selectAgentstackFindingsView([], false, ["status-v1"])).toMatchObject({
      hidden: 0,
      total: 0,
    });
    const two = selectAgentstackFindingsView(many.slice(0, 2), false, ["status-v1"], 3);
    expect(two.visible).toHaveLength(2);
    expect(two.hidden).toBe(0);
  });

  it("offers one machine-wide fix once, however many symptoms name it", () => {
    // Doctor writes one warn line per provider missing the guard hook, each
    // ending in the same `agentstack guard install`. Four identical buttons for
    // one machine-wide write reads as four separate repairs.
    const guard = (n: number) =>
      finding({
        key: `g${n}`,
        section: "t3code (supervisor)",
        fix: "agentstack guard install",
        action: "guard-install",
      });
    const view = selectAgentstackFindingsView([guard(0), guard(1), guard(2)], false, ["status-v1"]);
    expect(view.visible.map((v) => v.action)).toEqual(["guard-install", null, null]);
    // The command is still on every one of them — only the button is deduped.
    expect(view.visible.every((v) => v.finding.fix === "agentstack guard install")).toBe(true);
  });
});

describe("agentstackFindingAction", () => {
  const runnable: AgentstackFinding = {
    key: "t3code (supervisor):0",
    level: "warn",
    message: "guard hook missing",
    fix: "agentstack guard install",
    action: "guard-install",
    section: "t3code (supervisor)",
  };

  it("offers the button only when the CLI advertises the doctor contract", () => {
    expect(agentstackFindingAction(runnable, ["status-v1"])).toBe("guard-install");
    expect(agentstackFindingAction(runnable, ["profiles-v1"])).toBeNull();
    // Unknown/absent features (older CLI) → command only, never a blind action.
    expect(agentstackFindingAction(runnable, undefined)).toBeNull();
    expect(agentstackFindingAction(runnable, [])).toBeNull();
  });

  it("offers nothing for a fix the panel cannot run, however advertised", () => {
    expect(
      agentstackFindingAction({ ...runnable, fix: "agentstack trust .", action: null }, [
        "status-v1",
      ]),
    ).toBeNull();
  });

  it("never turns drift into one click, wherever it is rendered", () => {
    // The Manifest row deliberately routes drift to the review — adopt vs
    // apply differ and the scope has to be chosen. A "Re-render" button on the
    // same fact two rows below is that decision made twice, and the dangerous
    // one wins because it is the one click.
    expect(
      agentstackFindingAction(
        {
          key: "Drift:0",
          level: "warn",
          message: "Codex CLI 2 change(s) pending",
          fix: "agentstack apply --write",
          action: "apply-project",
          section: "Drift",
        },
        ["status-v1"],
      ),
    ).toBeNull();
  });
});

describe("formatAgentstackImportSummary", () => {
  it("never hides a settings import behind a zero server count", () => {
    expect(formatAgentstackImportSummary({ servers: 0, settingsFrom: ["Claude Code"] })).toBe(
      "no servers · settings from Claude Code",
    );
    expect(
      formatAgentstackImportSummary({ servers: 2, settingsFrom: ["Claude Code", "Codex CLI"] }),
    ).toBe("2 servers · settings from Claude Code, Codex CLI");
  });

  it("counts the sources once naming them would crowd the summary", () => {
    expect(formatAgentstackImportSummary({ servers: 1, settingsFrom: ["a", "b", "c"] })).toBe(
      "1 server · settings from 3 tools",
    );
  });

  it("says nothing to import rather than a zero", () => {
    expect(formatAgentstackImportSummary({ servers: 0, settingsFrom: [] })).toBe(
      "nothing to import",
    );
    expect(formatAgentstackImportSummary({ servers: 3, settingsFrom: [] })).toBe("3 servers");
  });
});

describe("formatAgentstackCount", () => {
  it("pluralizes on the number, so the panel never writes its own", () => {
    expect(formatAgentstackCount(1, "finding")).toBe("1 finding");
    expect(formatAgentstackCount(2, "finding")).toBe("2 findings");
    expect(formatAgentstackCount(0, "server")).toBe("0 servers");
  });
});

describe("selectAgentstackPrimaryConcern", () => {
  const guardRow: AgentstackOverviewRow = {
    key: "guard",
    label: "Guard",
    summary: "guard not enabled",
    level: "warn",
    action: "guard-install",
  };
  const driftRow: AgentstackOverviewRow = {
    key: "manifest",
    label: "Manifest",
    summary: "Codex CLI 10 change(s) pending",
    level: "warn",
    reviewDrift: true,
  };

  it("says nothing when nothing needs the user", () => {
    expect(
      selectAgentstackPrimaryConcern({
        rows: [{ key: "secrets", label: "Secrets", summary: "all resolve", level: "ok" }],
        findings: [],
        trust: "trusted",
      }),
    ).toBeNull();
  });

  it("puts an unreviewed project above every other concern", () => {
    // Nothing else on the panel can proceed while the repo is inert, so a
    // guard warning ranked above it would be a repair you cannot benefit from.
    const concern = selectAgentstackPrimaryConcern({
      rows: [guardRow],
      findings: [],
      trust: "inert",
    });
    expect(concern?.act).toEqual({ kind: "review-trust" });
    expect(concern?.others).toBe(1);
  });

  it("ranks drift above a one-click action, and never makes it one click", () => {
    const concern = selectAgentstackPrimaryConcern({
      rows: [guardRow, driftRow],
      findings: [],
      trust: "trusted",
    });
    expect(concern?.act).toEqual({ kind: "review-drift" });
    expect(concern?.others).toBe(1);
  });

  it("states an action as its consequence, and promises what the button promises", () => {
    const concern = selectAgentstackPrimaryConcern({
      rows: [guardRow],
      findings: [],
      trust: "trusted",
    });
    expect(concern?.act).toEqual({ kind: "action", action: "guard-install" });
    expect(concern?.label).toBe("Enable guard");
    expect(concern?.title).toBe("Agent commands run without a pre-check");
    expect(concern?.note).toBe("reversible · only adds protection");
  });

  it("falls through to the report's own words when it has no curated copy", () => {
    const row: AgentstackOverviewRow = {
      key: "library",
      label: "Library",
      summary: "2 skills are not installed",
      level: "error",
    };
    const concern = selectAgentstackPrimaryConcern({ rows: [row], findings: [], trust: "trusted" });
    expect(concern?.title).toBe("2 skills are not installed");
    expect(concern?.act).toEqual({ kind: "manage" });
  });

  it("never offers a finding's fix for drift, matching the checkup rule", () => {
    const finding: AgentstackFinding = {
      key: "Drift:0",
      level: "warn",
      message: "Codex CLI 2 change(s) pending",
      fix: "agentstack apply --write",
      action: "apply-project",
      section: "Drift",
    };
    const concern = selectAgentstackPrimaryConcern({
      rows: [],
      findings: [finding],
      trust: "trusted",
    });
    expect(concern?.act).toEqual({ kind: "manage" });
  });
});
