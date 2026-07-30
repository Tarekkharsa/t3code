import { describe, expect, it } from "vite-plus/test";

import {
  AGENTSTACK_FINDINGS_PREVIEW,
  agentstackFeatureKnownMissing,
  agentstackFindingAction,
  classifyAgentstackEditPreview,
  deriveAgentstackActivityRows,
  deriveAgentstackOverviewRows,
  deriveAgentstackPanelPosture,
  deriveAgentstackPolicyRows,
  deriveAgentstackProbeRows,
  deriveAgentstackProtectionRows,
  deriveAgentstackStatusChip,
  deriveAgentstackFindings,
  deriveAgentstackShareFacts,
  deriveAgentstackTrustBadge,
  describeAgentstackDriftStory,
  describeAgentstackProbeSkip,
  describeAgentstackFindingSection,
  describeAgentstackSerialRoles,
  deriveToolsetRows,
  deriveTrustSurface,
  deriveWorkflowCounts,
  deriveWorkflowStages,
  filterAgentstackLibraryItems,
  formatAgentstackCheckupSummary,
  formatAgentstackCount,
  formatAgentstackImportSummary,
  hasAgentstackFeature,
  matchAgentstackDenial,
  matchAgentstackNextAction,
  matchAgentstackTrustRefusal,
  partitionAgentstackOverviewRows,
  selectAgentstackFindingsView,
  selectAgentstackPrimaryConcern,
  selectAgentstackUpdateOffer,
  shortenAgentstackPath,
  shortenAgentstackPathsIn,
  selectAgentstackUndoEntry,
  selectAgentstackUndoView,
  shortDigest,
  stripAgentstackErrorPrefix,
  summarizeAgentstackHealthyRows,
  type AgentstackDoctorReport,
  type AgentstackFinding,
  type AgentstackOverviewRow,
  type AgentstackRestoreEntryLike,
  type AgentstackWorkflowStepLike,
  describeAgentstackActivation,
  describeAgentstackMode,
  groupAgentstackFindingViews,
  isAgentstackAbsentAdapterFinding,
  parseAgentstackDiff,
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

  it("tells the served-live story for a zero-files project instead of claiming a sync", () => {
    // `doctor-mode-v1`: the CLI suppresses the drift comparison for a derived
    // zero-files mode (nothing is rendered ON PURPOSE — the gateway serves the
    // project live) and says so with an ok line. Neither "in sync" nor
    // "rendered to N CLIs" would be honest here, and before the structured
    // `mode` field this state could only be guessed from that prose.
    const zeroFiles: AgentstackDoctorReport = {
      errors: 0,
      warnings: 0,
      mode: "zero-files",
      activation: "never_activated",
      sections: [
        {
          title: "Drift",
          lines: [
            {
              level: "ok",
              msg: "not rendering configs — zero-files serves this project live through the gateway",
            },
          ],
        },
      ],
    };
    const byKey = Object.fromEntries(
      deriveAgentstackOverviewRows(zeroFiles).map((r) => [r.key, r]),
    );
    expect(byKey["manifest"]).toMatchObject({
      level: "ok",
      summary: "served live via the gateway — nothing rendered on purpose",
    });
    // No render was compared, so no sync claim and no drift review to offer.
    expect(byKey["manifest"]).not.toHaveProperty("reviewDrift");
    expect(byKey["manifest"]).not.toHaveProperty("healthy");
  });
});

describe("describeAgentstackDriftStory", () => {
  it("adjudicates an outside edit above every other story", () => {
    expect(
      describeAgentstackDriftStory({
        scope: "project",
        changedCount: 2,
        editedCount: 1,
        neverRenderedCount: 2,
      }),
    ).toContain("edited outside agentstack");
  });

  it("narrates a first render only when every changed target is one", () => {
    // All-absent → the honest story is "nothing here yet", not an accusation
    // that files "no longer match".
    expect(
      describeAgentstackDriftStory({
        scope: "project",
        changedCount: 2,
        editedCount: 0,
        neverRenderedCount: 2,
      }),
    ).toContain("Nothing is rendered in this repo yet");
    expect(
      describeAgentstackDriftStory({
        scope: "global",
        changedCount: 1,
        editedCount: 0,
        neverRenderedCount: 1,
      }),
    ).toContain("Nothing is rendered in your global configs yet");
    // A mixed batch still holds files with real content at stake → neutral.
    expect(
      describeAgentstackDriftStory({
        scope: "project",
        changedCount: 2,
        editedCount: 0,
        neverRenderedCount: 1,
      }),
    ).toContain("no longer match the manifest");
  });

  it("keeps the neutral manifest-moved-ahead wording for older CLIs", () => {
    // A CLI predating `diff-existence-v1` never reports `existed_before`, so
    // the count stays 0 — including for an EMPTY-but-present file, the case
    // the old `@@ -0,0` hunk-header inference misclassified as a first render.
    expect(
      describeAgentstackDriftStory({
        scope: "global",
        changedCount: 1,
        editedCount: 0,
        neverRenderedCount: 0,
      }),
    ).toBe("Your global configs no longer match the manifest. Pick which one is the truth.");
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

    // Guard off → actionable enable, honestly labelled free. The on/off state
    // is its own field so the panel can render it as a chip; asserting it in
    // the prose is what let "on — …" and "off — …" read identically on screen.
    expect(byKey["guard"]).toMatchObject({
      level: "warn",
      action: "guard-install",
      state: "off",
    });
    expect(byKey["guard"]!.summary).toContain("without a pre-check");
    // A configured machine policy is the ceiling — its posture word surfaces.
    expect(byKey["machine-policy"]!.summary).toContain("restrictive");
    expect(byKey["machine-policy"]!.cost).toContain("no repo or UI can loosen");
    // Registered gateway → live serving on, with the inert-until-reviewed fact.
    expect(byKey["gateway"]).toMatchObject({ level: "ok", label: "Live serving", state: "on" });
    expect(byKey["gateway"]!.summary).toContain("stay inert");
    // Standing run tiers never claim to be active and name their real costs.
    // `state: null` is the load-bearing half of "never claim to be active":
    // these are capabilities of the binary, so there is no state to report and
    // the panel must not draw an on/off chip for them.
    expect(byKey["locked-run"]).toMatchObject({ level: "muted", state: null });
    expect(byKey["locked-run"]!.cost).toContain("not kernel isolation");
    expect(byKey["locked-run"]!.command).toContain("--locked");
    expect(byKey["sandbox"]).toMatchObject({ level: "muted", state: null });
    expect(byKey["sandbox"]!.cost).toContain("needs Docker");
    expect(byKey["sandbox"]!.command).toContain("--sandbox");
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
    expect(machine).toMatchObject({ level: "muted", state: "unset" });
    expect(machine!.summary).toContain("its own limits");
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

describe("selectAgentstackUndoView", () => {
  const entry = (over: Partial<AgentstackRestoreEntryLike>): AgentstackRestoreEntryLike => ({
    id: "a".repeat(16),
    time_unix: 1_000,
    scope: "project",
    summary: "1 file",
    undone: false,
    touches_project: true,
    ...over,
  });

  it("counts the newer machine-wide entries it is deliberately not offering", () => {
    // The real ledger after a machine-wide apply and a `use web` elsewhere: the
    // drawer still acts on this project's own last change, and now says how
    // much newer history it is not the front of.
    const view = selectAgentstackUndoView([
      entry({ id: "global-apply", time_unix: 900, scope: "global", touches_project: false }),
      entry({ id: "use-web", time_unix: 800, touches_project: false }),
      entry({ id: "project-apply", time_unix: 500, operation: "apply" }),
      // Older than the selection, so not "newer"; already undone, so not counted.
      entry({ id: "older-elsewhere", time_unix: 200, touches_project: false }),
      entry({ id: "undone-elsewhere", time_unix: 950, touches_project: false, undone: true }),
    ]);
    expect(view.entry?.id).toBe("project-apply");
    expect(view.entry?.operation).toBe("apply");
    expect(view.newerElsewhere).toBe(2);
  });

  it("counts nothing when there is nothing selected", () => {
    expect(selectAgentstackUndoView([])).toEqual({ entry: null, newerElsewhere: 0 });
    // Every project entry already undone → no selection, so no "newer" either.
    expect(
      selectAgentstackUndoView([
        entry({ id: "done", undone: true }),
        entry({ id: "elsewhere", time_unix: 9_000, touches_project: false }),
      ]),
    ).toEqual({ entry: null, newerElsewhere: 0 });
  });
});

describe("matchAgentstackTrustRefusal", () => {
  it("recognizes the CLI's session refusal, prefixed or not", () => {
    expect(
      matchAgentstackTrustRefusal(
        "error: refusing to start a session: the manifest or lockfile changed since this project was trusted — review with `agentstack trust` (or the UI trust review), then retry",
      ),
    ).toBe(true);
    expect(matchAgentstackTrustRefusal("Refusing to start a session: not trusted")).toBe(true);
    // Either half is enough — the wording travels between CLI versions.
    expect(matchAgentstackTrustRefusal("run `agentstack trust` first")).toBe(true);
  });

  it("is false for an ordinary failure and for nothing at all", () => {
    expect(matchAgentstackTrustRefusal("session start failed: profile 'web' not found")).toBe(
      false,
    );
    expect(matchAgentstackTrustRefusal("")).toBe(false);
    expect(matchAgentstackTrustRefusal(null)).toBe(false);
    expect(matchAgentstackTrustRefusal(undefined)).toBe(false);
    // Malformed input from a CLI that answered with something else entirely.
    expect(matchAgentstackTrustRefusal(42 as unknown as string)).toBe(false);
  });
});

describe("stripAgentstackErrorPrefix", () => {
  it("drops only the stream marker, leaving the CLI's sentence verbatim", () => {
    expect(stripAgentstackErrorPrefix("error: refusing to start a session: x")).toBe(
      "refusing to start a session: x",
    );
    expect(stripAgentstackErrorPrefix("ERROR:  spaced")).toBe("spaced");
    expect(stripAgentstackErrorPrefix("no marker here")).toBe("no marker here");
    // Never a second one — only the leading marker is the stream's.
    expect(stripAgentstackErrorPrefix("error: error: twice")).toBe("error: twice");
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

  it("carries the reason a call failed, which is the question the feed exists to answer", () => {
    const now = 10_000;
    const [denied, errored] = deriveAgentstackActivityRows(
      [
        {
          ts: now - 30,
          server: "github",
          tool: "create_pr",
          outcome: "error",
          ms: 1_500,
          run: "w-9f2a41bc77",
          args_digest: "0123456789abcdef",
          detail: "upstream-error",
        },
        {
          ts: now - 10,
          server: "host-guard",
          tool: "bash: rm -rf /",
          outcome: "denied",
          ms: 2,
          detail: "policy.filesystem deny: /",
        },
      ],
      now,
    ).slice(0, 2);
    expect(denied).toMatchObject({ outcome: "denied", reason: "policy.filesystem deny: /" });
    expect(errored).toMatchObject({
      outcome: "error",
      reason: "upstream-error",
      run: "w-9f2a41bc77",
      runShort: "w-9f2a41",
      digest: "0123456789ab",
      duration: "1.5s",
    });
  });

  it("never explains a call that succeeded, and never invents fields the event omits", () => {
    const now = 10_000;
    const [row] = deriveAgentstackActivityRows(
      // A detail on an `ok` outcome is not a failure reason; showing it would
      // be an explanation of nothing.
      [{ ts: now, server: "figma", tool: "get_file", outcome: "ok", detail: "cached" }],
      now,
    );
    expect(row).not.toHaveProperty("reason");
    expect(row).not.toHaveProperty("run");
    expect(row).not.toHaveProperty("digest");
    expect(row).not.toHaveProperty("duration");
  });

  it("bounds a reason, because the row is where recorded text reaches the DOM", () => {
    const now = 10_000;
    const [row] = deriveAgentstackActivityRows(
      [
        {
          ts: now,
          server: "s",
          tool: "t",
          outcome: "denied",
          detail: `deny ${"y".repeat(400)}`,
        },
      ],
      now,
    );
    expect(row!.reason!.length).toBeLessThanOrEqual(120);
    expect(row!.reason!.endsWith("…")).toBe(true);
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

  it("routes the trust recommendation to the review, in both spellings", () => {
    // Not a write: `review-trust` is a destination, and every consumer sends it
    // to the review screen rather than the action RPC. Recommending it as
    // unclickable text was the panel's longest-standing dead end.
    expect(matchAgentstackNextAction("agentstack trust")).toBe("review-trust");
    expect(matchAgentstackNextAction("agentstack trust .")).toBe("review-trust");
    expect(matchAgentstackNextAction("  agentstack   trust  . ")).toBe("review-trust");
    // Still exact — a flag-laden or scoped trust command is not this one.
    expect(matchAgentstackNextAction("agentstack trust --yes")).toBeNull();
    expect(matchAgentstackNextAction("agentstack trust ./sub")).toBeNull();
  });

  it("routes trust-with-the-project's-own-path to the review too", () => {
    // Doctor's real recommendation carries the absolute project path, which
    // the exact list can never contain — and rendering IT as dead text while
    // the finding below offered "Review & trust" was one instruction in two
    // forms, only one of them pressable.
    expect(matchAgentstackNextAction("agentstack trust /Users/x/proj")).toBe("review-trust");
    // A flagged form is a different command; a path with spaces stays text
    // rather than risking a wrong match.
    expect(matchAgentstackNextAction("agentstack trust /p --yes")).toBeNull();
    expect(matchAgentstackNextAction("agentstack trust /a b")).toBeNull();
  });

  it("returns null for anything it does not exactly recognize", () => {
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
    expect(f?.fixOptions).toEqual([
      { label: null, text: "agentstack apply --write", isCommand: true },
    ]);
    expect(f?.action).toBe("apply-project");
    expect(f?.section).toBe("Drift");
  });

  it("maps a fix naming `agentstack trust` to the review, not to nothing", () => {
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "Trust",
          lines: [
            {
              level: "error",
              msg: "this project is not trusted at its current bytes ↳ agentstack trust",
            },
          ],
        },
      ]),
    );
    expect(f?.fix).toBe("agentstack trust");
    expect(f?.action).toBe("review-trust");
  });

  it("offers the review for the wordings doctor actually writes", () => {
    // The re-gated project's own checkup line reads "review + agentstack
    // trust", and the untrusted-with-gateway line appends the project root.
    // Neither is an exact whitelist entry, and both are the finding that makes
    // every other one moot — so the review is keyed on the command being NAMED.
    const [drifted] = deriveAgentstackFindings(
      report([
        {
          title: "Zero-files gateway",
          lines: [
            {
              level: "warn",
              msg: "trusted, but the manifest or lockfile changed since ↳ review + agentstack trust",
            },
          ],
        },
      ]),
    );
    expect(drifted?.action).toBe("review-trust");

    const [untrusted] = deriveAgentstackFindings(
      report([
        {
          title: "Zero-files gateway",
          lines: [
            {
              level: "warn",
              msg: "not trusted — 2 CLI(s) use the gateway ↳ agentstack trust /Users/ada/proj",
            },
          ],
        },
      ]),
    );
    expect(untrusted?.action).toBe("review-trust");

    // Word-bounded: a longer verb is not `trust`.
    const [other] = deriveAgentstackFindings(
      report([
        { title: "Skills", lines: [{ level: "warn", msg: "x ↳ agentstack trust-store list" }] },
      ]),
    );
    expect(other?.action).toBeNull();
  });

  it("keeps a two-option remedy as two options, not one unrunnable line", () => {
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "Drift",
          lines: [
            {
              level: "warn",
              msg: "Claude Code would REMOVE figma ↳ keep them: agentstack adopt --scope global · prune them: agentstack apply --prune-foreign --scope global",
            },
          ],
        },
      ]),
    );
    expect(f?.fixOptions).toEqual([
      { label: "keep them", text: "agentstack adopt --scope global", isCommand: true },
      {
        label: "prune them",
        text: "agentstack apply --prune-foreign --scope global",
        isCommand: true,
      },
    ]);
  });

  it("does not typeset a prose alternative as a command to paste", () => {
    // doctor mixes a command and prose in one remedy; only the first is
    // runnable, and offering the second as copyable code invites a paste that
    // does nothing.
    const [f] = deriveAgentstackFindings(
      report([
        {
          title: "Skills",
          lines: [
            {
              level: "warn",
              msg: "Claude Code broken skill link 'x' → /p (target missing) ↳ remove it: rm /p/x · or reinstall the skill it points at",
            },
          ],
        },
      ]),
    );
    expect(f?.fixOptions).toEqual([
      { label: "remove it", text: "rm /p/x", isCommand: true },
      { label: null, text: "or reinstall the skill it points at", isCommand: false },
    ]);
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
            { level: "warn", msg: "needs a secret ↳ agentstack secret set GH_PAT" },
          ],
        },
      ]),
    );
    expect(found[0]?.fix).toBeNull();
    expect(found[0]?.action).toBeNull();
    expect(found[1]?.fix).toBe("agentstack secret set GH_PAT");
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
  // Counts only, no "open the list below": the string can be quoted where no
  // list follows (the popover's fallback concern), and where one does follow
  // it is open and adjacent.
  it("pluralizes each count and keeps the promise that every finding names a fix", () => {
    expect(formatAgentstackCheckupSummary(1, 7)).toBe("1 error · 7 warnings");
    expect(formatAgentstackCheckupSummary(2, 1)).toBe("2 errors · 1 warning");
  });

  it("names only the level that exists, and says nothing is wrong when nothing is", () => {
    expect(formatAgentstackCheckupSummary(0, 1)).toBe("1 warning");
    expect(formatAgentstackCheckupSummary(3, 0)).toBe("3 errors");
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
    fixOptions: [],
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
    fixOptions: [{ label: null, text: "agentstack guard install", isCommand: true }],
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
      agentstackFindingAction({ ...runnable, fix: "agentstack secret set GH_PAT", action: null }, [
        "status-v1",
      ]),
    ).toBeNull();
  });

  it("offers the trust review on every binary — the gate is about running fixes", () => {
    // `status-v1` gates offering to RUN a command scraped out of doctor's prose.
    // The trust review runs nothing; it is this panel's own screen, and the
    // finding that names `agentstack trust` is the one that must never be left
    // as text.
    const trust: AgentstackFinding = {
      ...runnable,
      key: "Trust:0",
      fix: "agentstack trust",
      fixOptions: [{ label: null, text: "agentstack trust", isCommand: true }],
      action: "review-trust",
      section: "Trust",
    };
    expect(agentstackFindingAction(trust, ["status-v1"])).toBe("review-trust");
    expect(agentstackFindingAction(trust, undefined)).toBe("review-trust");
    expect(agentstackFindingAction(trust, [])).toBe("review-trust");
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
          fixOptions: [{ label: null, text: "agentstack apply --write", isCommand: true }],
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
    // The card states the choice waiting for the user, not the row's status
    // fragment — and never asserts a hand-edit the glance cannot see.
    expect(concern?.detail).toBe(
      "Keep what's on disk or re-render from the manifest — you choose which truth to keep.",
    );
    expect(concern?.detail).not.toBe(driftRow.summary);
    expect(concern?.title).not.toMatch(/hand-edited/i);
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
      fixOptions: [{ label: null, text: "agentstack apply --write", isCommand: true }],
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

  it("counts a warning once, not once as the Checkup row and again as its finding", () => {
    // The Checkup row summarizes the findings; both derive from one report.
    // Counting the pointer beside what it points at made "others" one too
    // high for every warning on the panel — a claim the reader could check
    // in Manage and find false.
    const checkupRow: AgentstackOverviewRow = {
      key: "doctor",
      label: "Checkup",
      summary: "1 warning",
      level: "warn",
    };
    const finding: AgentstackFinding = {
      key: "Secrets:0",
      level: "warn",
      message: "GITHUB_TOKEN not found",
      fix: null,
      fixOptions: [],
      action: null,
      section: "Secrets",
    };
    const concern = selectAgentstackPrimaryConcern({
      rows: [checkupRow],
      findings: [finding],
      trust: "inert",
    });
    expect(concern?.act).toEqual({ kind: "review-trust" });
    expect(concern?.others).toBe(1);
  });
});

describe("describeAgentstackFindingSection", () => {
  it("renders the internal gateway section as the name the Protection sheet uses", () => {
    expect(describeAgentstackFindingSection("Zero-files gateway")).toBe("Live serving");
  });

  it("passes every other title through verbatim, including future ones", () => {
    expect(describeAgentstackFindingSection("Adapters & CLIs")).toBe("Adapters & CLIs");
    expect(describeAgentstackFindingSection("Brand-new section")).toBe("Brand-new section");
  });
});

describe("deriveTrustSurface", () => {
  const srv = (name: string, kind: string, target: string) => ({ name, kind, target });

  it("leads with what cannot be judged, then what runs, then what reaches the network", () => {
    // A repo declaring many servers buries the one entry that deserved a
    // second look; the unresolvable band exists so it is never the fifteenth
    // row down.
    const s = deriveTrustSurface(
      [
        srv("figma", "http", "mcp.figma.com"),
        srv("github", "stdio", "npx -y @modelcontextprotocol/server-github"),
        srv("broken", "unresolvable", "${MISSING} did not resolve"),
        srv("pg", "stdio", "postgres-mcp"),
      ],
      { skills: 2, workflows: 0, extensions: 0, instructions: 0, secrets: 1 },
    );
    expect(s.groups.map((g) => g.key)).toEqual(["unresolvable", "stdio", "http"]);
    expect(s.groups[0]!.servers.map((x) => x.name)).toEqual(["broken"]);
    expect(s.groups[0]!.level).toBe("warn");
    // Manifest order is preserved inside a band — two reviews of one repo must
    // not look different.
    expect(s.groups[1]!.servers.map((x) => x.name)).toEqual(["github", "pg"]);
  });

  it("omits a band nobody declared, rather than showing an empty heading", () => {
    const s = deriveTrustSurface([srv("figma", "http", "mcp.figma.com")], {
      skills: 0,
      workflows: 0,
      extensions: 0,
      instructions: 0,
      secrets: 0,
    });
    expect(s.groups.map((g) => g.key)).toEqual(["http"]);
    expect(s.summary).toBe("1 server · 1 reaches the network");
  });

  it("summarizes what approving covers, naming secrets last and never dropping them", () => {
    const s = deriveTrustSurface(
      [srv("a", "stdio", "x"), srv("b", "http", "y"), srv("c", "unresolvable", "z")],
      { skills: 4, workflows: 0, extensions: 0, instructions: 0, secrets: 2 },
    );
    expect(s.summary).toBe(
      "3 servers · 1 runs a command · 1 reaches the network · 1 unresolvable · 4 skills · 2 secrets",
    );
    expect(s.serverCount).toBe(3);
  });

  it("says nothing is declared rather than showing a bare zero", () => {
    const s = deriveTrustSurface([], {
      skills: 0,
      workflows: 0,
      extensions: 0,
      instructions: 0,
      secrets: 0,
    });
    expect(s.groups).toEqual([]);
    expect(s.summary).toBe("nothing declared");
  });

  it("never files a changed-since-pinned server under 'can't be resolved'", () => {
    // `unverified` means the definition on disk no longer matches its lockfile
    // pin — the opposite of a typo, and the highest-stakes row on the screen.
    // Merging it into the unresolvable band makes it read as a benign
    // misconfiguration.
    const s = deriveTrustSurface(
      [
        srv("figma", "http", "mcp.figma.com"),
        srv("swapped", "unverified", "library definition does not match the lockfile pin"),
        srv("gone", "unresolvable", "${MISSING} did not resolve"),
      ],
      { skills: 0, workflows: 0, extensions: 0, instructions: 0, secrets: 0 },
    );
    expect(s.groups.map((g) => g.key)).toEqual(["unverified", "unresolvable", "http"]);
    expect(s.groups[0]!.servers.map((x) => x.name)).toEqual(["swapped"]);
    expect(s.groups[0]!.level).toBe("warn");
    expect(s.groups[0]!.title).not.toMatch(/resolve/i);
    expect(s.summary).toContain("1 changed since pinned");
  });

  it("counts every declared capability, so the bar never says 'nothing' over a real surface", () => {
    // A repo can declare no servers and still declare workflows that name the
    // agent roles they may spawn. "nothing declared" there would be false in
    // the one line guaranteed to be on screen at the moment of consent.
    const s = deriveTrustSurface([], {
      skills: 0,
      workflows: 3,
      extensions: 2,
      instructions: 1,
      secrets: 0,
    });
    expect(s.summary).toBe("0 servers · 3 workflows · 2 extensions · 1 instruction");
    expect(s.summary).not.toContain("nothing declared");
  });

  it("treats an unrecognized kind as unjudgeable rather than dropping the row", () => {
    // A newer CLI could emit a kind this build has never seen. Silently
    // omitting it would understate the surface being consented to.
    const s = deriveTrustSurface([srv("odd", "websocket", "wss://x")], {
      skills: 0,
      workflows: 0,
      extensions: 0,
      instructions: 0,
      secrets: 0,
    });
    expect(s.groups.map((g) => g.key)).toEqual(["unresolvable"]);
    expect(s.serverCount).toBe(1);
  });
});

describe("selectAgentstackUpdateOffer", () => {
  it("offers the furthest-along step, so it never asks for work already done", () => {
    // A downloaded update needs restarting, not downloading again.
    expect(
      selectAgentstackUpdateOffer({ isDesktop: true, action: "install", canCheck: true }),
    ).toEqual({ kind: "install", label: "Restart to update" });
    expect(
      selectAgentstackUpdateOffer({ isDesktop: true, action: "download", canCheck: true }),
    ).toEqual({ kind: "download", label: "Download update" });
    expect(
      selectAgentstackUpdateOffer({ isDesktop: true, action: "none", canCheck: true }),
    ).toEqual({ kind: "check", label: "Check for updates" });
  });

  it("says where to get a newer build instead of a button that cannot work", () => {
    // The whole point of the change: a correct refusal must not be a dead end,
    // but offering an update button in a browser would be a different lie.
    const web = selectAgentstackUpdateOffer({ isDesktop: false, action: "none", canCheck: false });
    expect(web.kind).toBe("none");
    expect(web.kind === "none" && web.note).toContain("desktop app");

    // `status: "disabled"` specifically — an omitted status means "the host
    // hasn't reported yet", which must NOT read as unavailable.
    const disabled = selectAgentstackUpdateOffer({
      isDesktop: true,
      action: "none",
      canCheck: false,
      status: "disabled",
    });
    expect(disabled.kind).toBe("none");
    expect(disabled.kind === "none" && disabled.note).toContain(
      "Automatic updates are unavailable",
    );
  });

  it("never calls an update in flight 'unavailable'", () => {
    // Both of these make `canCheck` false, so without their own branch they
    // fall into the unavailable copy — telling the user updates are
    // unavailable while one is literally downloading.
    const downloading = selectAgentstackUpdateOffer({
      isDesktop: true,
      action: "none",
      canCheck: false,
      status: "downloading",
    });
    expect(downloading.kind).toBe("none");
    expect(downloading.kind === "none" && downloading.note).toContain("downloading");
    expect(downloading.kind === "none" && downloading.note).not.toContain("unavailable");

    const checking = selectAgentstackUpdateOffer({
      isDesktop: true,
      action: "none",
      canCheck: false,
      status: "checking",
    });
    expect(checking.kind === "none" && checking.note).toContain("Checking");
  });

  it("does not call updates unavailable before the host has reported", () => {
    // The state arrives asynchronously, so an early desktop render has no
    // status at all. That is ignorance, not absence, and the copy must not
    // turn one into the other.
    const early = selectAgentstackUpdateOffer({ isDesktop: true, action: "none", canCheck: false });
    expect(early.kind).toBe("none");
    expect(early.kind === "none" && early.note).not.toContain("unavailable");
  });

  it("still prefers a ready action over an in-flight status", () => {
    // A downloaded update reports status "downloaded"; the verb wins.
    expect(
      selectAgentstackUpdateOffer({
        isDesktop: true,
        action: "install",
        canCheck: false,
        status: "downloaded",
      }),
    ).toEqual({ kind: "install", label: "Restart to update" });
  });

  it("never offers a self-update path in a browser, whatever the host state says", () => {
    expect(
      selectAgentstackUpdateOffer({ isDesktop: false, action: "install", canCheck: true }).kind,
    ).toBe("none");
  });
});

describe("classifyAgentstackEditPreview", () => {
  const REFUSAL = "won't delete 'spare' — it is the only toolset here";

  it("confirms on a digest, whatever else came along", () => {
    const outcome = classifyAgentstackEditPreview({
      preview: { consent_digest: "sha256:abc" },
      refusal: null,
    });
    expect(outcome.kind).toBe("confirm");
    expect(outcome.kind === "confirm" && outcome.digest).toBe("sha256:abc");
  });

  it("keeps the CLI's refusal as a refusal, never as old-CLI", () => {
    expect(classifyAgentstackEditPreview({ preview: null, refusal: REFUSAL })).toEqual({
      kind: "refused",
      message: REFUSAL,
    });
  });

  it("treats no-answer as unavailable — RPC null, or the server saying so", () => {
    expect(classifyAgentstackEditPreview(null).kind).toBe("unavailable");
    expect(
      classifyAgentstackEditPreview({ preview: null, refusal: null, unavailable: true }).kind,
    ).toBe("unavailable");
  });

  it("reserves unsupported for the genuinely digest-less answers", () => {
    // A decoded preview with a null digest, or nothing decoded and nothing
    // refused — the two shapes an old CLI actually produces.
    expect(
      classifyAgentstackEditPreview({ preview: { consent_digest: null }, refusal: null }).kind,
    ).toBe("unsupported");
    expect(classifyAgentstackEditPreview({ preview: null, refusal: null }).kind).toBe(
      "unsupported",
    );
    // A blank refusal is no refusal.
    expect(classifyAgentstackEditPreview({ preview: null, refusal: "  " }).kind).toBe(
      "unsupported",
    );
  });
});

describe("deriveAgentstackPanelPosture", () => {
  const healthy = {
    hasStatus: true,
    installed: true,
    unreachable: false,
    doctorReadable: true,
    incompatible: false,
    setupState: "ready",
    hasConcern: false,
  };

  it("says ready only when the body would show the working-under region", () => {
    expect(deriveAgentstackPanelPosture(healthy)).toBe("ready");
  });

  it("never says Ready for a needs_setup project, whatever else is true", () => {
    // The regression: the header read only `concern`, so an uninitialized
    // project (no concern, no findings) wore a Ready chip over a body that
    // said "not set up". Sweep the other inputs to pin the invariant, not
    // just the one observed combination.
    for (const hasConcern of [true, false]) {
      for (const incompatible of [true, false]) {
        for (const unreachable of [true, false]) {
          expect(
            deriveAgentstackPanelPosture({
              ...healthy,
              setupState: "needs_setup",
              hasConcern,
              incompatible,
              unreachable,
            }),
          ).not.toBe("ready");
        }
      }
    }
  });

  it("warns for an incompatible CLI even when doctor decoded nothing", () => {
    // The body shows "update needed" here; a hidden or green chip above that
    // region would be the same split claim the needs_setup bug was.
    expect(
      deriveAgentstackPanelPosture({ ...healthy, incompatible: true, doctorReadable: false }),
    ).toBe("attention");
  });

  it("warns when a concern is picked", () => {
    expect(deriveAgentstackPanelPosture({ ...healthy, hasConcern: true })).toBe("attention");
  });

  it("stays hidden while checking, unreachable, not installed, or unreadable", () => {
    expect(deriveAgentstackPanelPosture({ ...healthy, hasStatus: false, installed: false })).toBe(
      "hidden",
    );
    expect(deriveAgentstackPanelPosture({ ...healthy, unreachable: true })).toBe("hidden");
    expect(deriveAgentstackPanelPosture({ ...healthy, installed: false })).toBe("hidden");
    expect(deriveAgentstackPanelPosture({ ...healthy, doctorReadable: false })).toBe("hidden");
  });
});

describe("describeAgentstackSerialRoles", () => {
  it("names the serial role and says the ceiling doesn't apply to it", () => {
    const note = describeAgentstackSerialRoles({
      serialRoles: ["builder"],
      maxAgents: 4,
      known: true,
    });
    expect(note).toContain("builder");
    expect(note).toContain("one child at a time");
    expect(note).toContain("4");
  });

  it("stays silent when the CLI doesn't advertise the contract", () => {
    expect(
      describeAgentstackSerialRoles({ serialRoles: ["builder"], maxAgents: 4, known: false }),
    ).toBeNull();
  });

  it("stays silent when no role is serial", () => {
    expect(
      describeAgentstackSerialRoles({ serialRoles: [], maxAgents: 4, known: true }),
    ).toBeNull();
    expect(
      describeAgentstackSerialRoles({ serialRoles: undefined, maxAgents: 4, known: true }),
    ).toBeNull();
  });

  it("pluralizes for several serial roles", () => {
    const note = describeAgentstackSerialRoles({
      serialRoles: ["builder", "packager"],
      maxAgents: 8,
      known: true,
    });
    expect(note).toContain("builder, packager run");
  });
});

describe("deriveAgentstackProbeRows", () => {
  it("reports a started server with its identity and tool count", () => {
    const [row] = deriveAgentstackProbeRows([
      { server: "figma", status: "ok", server_name: "figma-mcp", tools: 12, elapsed_ms: 840 },
    ]);
    expect(row?.level).toBe("ok");
    expect(row?.text).toContain("840ms");
    expect(row?.text).toContain("figma-mcp");
    expect(row?.text).toContain("12 tools");
  });

  it("keeps the CLI's own reason for a failure", () => {
    const [row] = deriveAgentstackProbeRows([
      { server: "broken", status: "failed", detail: "exited before the handshake" },
    ]);
    expect(row).toEqual({
      name: "broken",
      level: "error",
      text: "exited before the handshake",
    });
  });

  it("treats not_probeable as a warning, not a failure", () => {
    const [row] = deriveAgentstackProbeRows([
      { server: "search", status: "not_probeable", detail: "unresolved secret(s): SEARCH_TOKEN" },
    ]);
    expect(row?.level).toBe("warn");
    expect(row?.text).toContain("SEARCH_TOKEN");
  });

  it("degrades an unknown status from a newer CLI without guessing", () => {
    const [row] = deriveAgentstackProbeRows([{ server: "next", status: "quarantined" }]);
    expect(row?.level).toBe("warn");
    expect(row?.text).toBe("quarantined");
  });
});

describe("describeAgentstackProbeSkip", () => {
  it("routes an untrusted project to the review, not a retry", () => {
    const skip = describeAgentstackProbeSkip("untrusted");
    expect(skip.reviewTrust).toBe(true);
    expect(skip.text).toContain("isn't trusted");
  });

  it("routes drift to the review too", () => {
    expect(describeAgentstackProbeSkip("drifted").reviewTrust).toBe(true);
  });

  it("offers no review for an unexplained skip", () => {
    expect(describeAgentstackProbeSkip(null).reviewTrust).toBe(false);
  });
});

describe("parseAgentstackDiff", () => {
  it("classifies and counts add/delete lines without counting the file headers", () => {
    // `--- a/x` and `+++ b/x` open with the same markers as content lines; a
    // naive split counts them as one deletion and one addition per file.
    const parsed = parseAgentstackDiff(
      [
        "--- a/.codex/config.toml",
        "+++ b/.codex/config.toml",
        "@@ -1,3 +1,3 @@",
        " keep = 1",
        "-startup_timeout_sec = 20",
        "+startup_timeout_sec = 30",
      ].join("\n"),
    );
    expect(parsed).toMatchObject({ additions: 1, deletions: 1, truncated: false });
    expect(parsed.lines.map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
    ]);
  });

  it("strips the marker so every line starts in the same column", () => {
    const parsed = parseAgentstackDiff(["+added", "-removed", " context"].join("\n"));
    expect(parsed.lines.map((l) => l.text)).toEqual(["added", "removed", "context"]);
  });

  it("counts the whole diff even where it stops drawing it", () => {
    // The header stat is a claim about the change, not about how much fits on
    // screen — a capped render that also capped the count would understate it.
    const parsed = parseAgentstackDiff(Array.from({ length: 400 }, () => "+x").join("\n"));
    expect(parsed.additions).toBe(400);
    expect(parsed.truncated).toBe(true);
    expect(parsed.lines.length).toBeLessThan(400);
  });

  it("degrades to nothing on empty input", () => {
    expect(parseAgentstackDiff("")).toMatchObject({ additions: 0, deletions: 0, lines: [] });
  });
});

describe("groupAgentstackFindingViews", () => {
  const view = (
    section: string,
    key: string,
    level: "warn" | "error" = "warn",
    action: "review-trust" | null = null,
  ) => ({
    finding: {
      key,
      level,
      message: `${key} message`,
      fix: null,
      fixOptions: [],
      action: null,
      section,
    },
    action,
  });

  it("folds one section into one block, preserving first-appearance order", () => {
    const groups = groupAgentstackFindingViews([
      view("Drift", "d1"),
      view("Adapters & CLIs", "a1"),
      view("Drift", "d2"),
      view("Drift", "d3"),
    ]);
    expect(groups.map((g) => g.section)).toEqual(["Drift", "Adapters & CLIs"]);
    expect(groups[0]!.items).toHaveLength(3);
  });

  it("takes the worst level in the group, so a note cannot hide a blocker", () => {
    const groups = groupAgentstackFindingViews([
      view("Drift", "d1", "warn"),
      view("Drift", "d2", "error"),
    ]);
    expect(groups[0]!.level).toBe("error");
  });

  it("surfaces the group's one action rather than repeating it per finding", () => {
    const groups = groupAgentstackFindingViews([
      view("Trust", "t1", "warn", null),
      view("Trust", "t2", "warn", "review-trust"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.action).toBe("review-trust");
  });

  it("reports no action for a group where none was offered", () => {
    expect(groupAgentstackFindingViews([view("Drift", "d1")])[0]!.action).toBeNull();
  });
});

describe("describeAgentstackMode", () => {
  it("says whether files persist, which is what other screens key off", () => {
    expect(describeAgentstackMode("static")?.persistsOnDisk).toBe(true);
    expect(describeAgentstackMode("clean-at-rest")?.persistsOnDisk).toBe(false);
    expect(describeAgentstackMode("zero-files")?.persistsOnDisk).toBe(false);
  });

  it("says nothing when the CLI reported no mode", () => {
    // Guessing here mislabels whether the user's files should exist at all.
    expect(describeAgentstackMode(null)).toBeNull();
    expect(describeAgentstackMode(undefined)).toBeNull();
    expect(describeAgentstackMode("")).toBeNull();
  });

  it("treats an unrecognized mode as persisting, the conservative direction", () => {
    // Keeps paths qualified rather than silently promising permanence.
    const future = describeAgentstackMode("some-future-mode");
    expect(future).toMatchObject({ label: "some-future-mode", persistsOnDisk: true });
  });

  it("never shows the internal token as the label for a known mode", () => {
    for (const mode of ["static", "clean-at-rest", "zero-files"]) {
      expect(describeAgentstackMode(mode)?.label).not.toContain(mode);
    }
  });
});

describe("describeAgentstackActivation", () => {
  it("explains an absent lockfile, and stays quiet otherwise", () => {
    expect(describeAgentstackActivation("never_activated")).toContain("Not activated yet");
    expect(describeAgentstackActivation("locked")).toBeNull();
    expect(describeAgentstackActivation(null)).toBeNull();
  });
});

describe("isAgentstackAbsentAdapterFinding", () => {
  const finding = (message: string) => ({
    key: "k",
    level: "warn" as const,
    message,
    fix: null,
    fixOptions: [],
    action: null,
    section: "Adapters & CLIs",
  });

  it("recognizes the config-without-binary warning", () => {
    expect(
      isAgentstackAbsentAdapterFinding(finding("VS Code config present but binary not on PATH")),
    ).toBe(true);
  });

  it("does not claim an installed adapter or an unrelated finding", () => {
    // Over-matching here would offer "Edit targets" for a finding whose answer
    // is not an edit, which is worse than offering nothing.
    expect(isAgentstackAbsentAdapterFinding(finding("Codex CLI installed · parses"))).toBe(false);
    expect(isAgentstackAbsentAdapterFinding(finding("not detected (ok unless you use it)"))).toBe(
      false,
    );
    expect(isAgentstackAbsentAdapterFinding(finding("config invalid · bad toml"))).toBe(false);
  });

  it("stops claiming anything if doctor rewords the line", () => {
    // The safe direction: the finding still renders, we just say less about it.
    expect(isAgentstackAbsentAdapterFinding(finding("VS Code binary missing"))).toBe(false);
  });
});
