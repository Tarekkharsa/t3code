import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentstackActivityEvent,
  AgentstackDoctorReport,
  AgentstackTrustPreview,
} from "./agentstack.ts";

// Decode witnesses against REAL payloads captured from `agentstack trust
// --preview` / `doctor --json` (agentstack 0.18.0-rc, 2026-08-01), trimmed to
// the fields under test plus enough context to stay honest. The panel's whole
// negotiation model rests on these shapes surviving decode: a field the schema
// silently drops is a field no feature gate can ever render.

const decodePreview = Schema.decodeUnknownSync(AgentstackTrustPreview);
const decodeDoctor = Schema.decodeUnknownSync(AgentstackDoctorReport);
const decodeEvents = Schema.decodeUnknownSync(
  Schema.Struct({ events: Schema.Array(AgentstackActivityEvent) }),
);

// ── trust-card-diff-v1 ───────────────────────────────────────────────────────

/**
 * `agentstack trust <path> --preview` on a project that was approved, then had
 * its `summarize` skill edited and re-locked. Verbatim, whole, unedited: the
 * complete stdout of the real binary (0.18.0-rc.2, 2026-08-01) over a maximal
 * fixture — one stdio server, one http server, one central-library server,
 * secrets, an extension, a workflow, an inline skill, an instruction, a hook, a
 * settings block and a policy request. Whole rather than trimmed because the
 * property under test is that EVERY kind the CLI emits survives decode; a
 * trimmed payload only ever witnesses the kinds someone remembered to keep.
 */
const PREVIEW_REGATE = {
  path: "/private/tmp/claude-608725469/-Users-tarek-k-Documents-GitHub-agentstack--claude-worktrees-quirky-mahavira-b4264d/55e0b910-5e83-42d6-b14b-67ce9a340b0f/scratchpad/captures/proj",
  state: "drifted",
  re_trust: true,
  surface_digest: "sha256:a2f10f3e2c3698c48010fcb8e8de99991f37db7e2801b48f429d49cf72452da1",
  servers: [
    {
      name: "filesystem",
      kind: "stdio",
      target: "npx -y @modelcontextprotocol/server-filesystem .",
    },
    {
      name: "docs",
      kind: "http",
      target: "https://api.example.com/mcp/docs",
    },
    {
      name: "kibana",
      kind: "stdio",
      target: "node kibana.js",
    },
  ],
  server_blockers: [],
  secrets: ["DOCS_TOKEN"],
  skills: ["summarize"],
  workflows: [
    {
      name: "pipeline",
      roles: ["worker"],
    },
  ],
  extensions: [
    {
      name: "addon",
      target: "pi",
    },
  ],
  instructions: ["house-rules"],
  hooks: [
    {
      name: "pre-commit",
      event: "PreToolUse",
      matcher: "Bash",
      runs: "./scripts/check.sh --strict",
      targets: ["*"],
      executable: true,
    },
  ],
  settings: [
    {
      adapter: "claude-code",
      sets: ["permissions"],
    },
  ],
  policy_requested: ["\u00b7 egress docs: api.example.com"],
  machine_policy_ceiling:
    "/private/tmp/claude-608725469/-Users-tarek-k-Documents-GitHub-agentstack--claude-worktrees-quirky-mahavira-b4264d/55e0b910-5e83-42d6-b14b-67ce9a340b0f/scratchpad/captures/home/.agentstack/agentstack.toml",
  counts: {
    skills: 1,
    workflows: 1,
    extensions: 1,
    instructions: 1,
    hooks: 1,
    settings: 1,
  },
  review: {
    re_review: true,
    prior_recorded: true,
    items: [
      {
        kind: "server",
        name: "filesystem",
        change: "unchanged",
        identity: "npx -y @modelcontextprotocol/server-filesystem .",
        runs: ["npx -y @modelcontextprotocol/server-filesystem ."],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "server",
        name: "docs",
        change: "unchanged",
        identity: "https://api.example.com/mcp/docs",
        runs: [],
        contacts: ["https://api.example.com/mcp/docs"],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "server",
        name: "kibana",
        change: "unchanged",
        identity: "node kibana.js",
        runs: ["node kibana.js"],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "secrets",
        name: "",
        change: "unchanged",
        identity: "DOCS_TOKEN",
        runs: [],
        contacts: [],
        may_read: ["DOCS_TOKEN"],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "extension",
        name: "addon",
        change: "unchanged",
        identity: "pi",
        runs: [],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "workflow",
        name: "pipeline",
        change: "unchanged",
        identity: "worker",
        runs: [],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "skill",
        name: "summarize",
        change: "unchanged",
        identity: "inline",
        runs: [],
        contacts: [],
        may_read: [],
        pin: "d6f7db9bafc6cf41bc5a71db1e422a8c8f3b7f9737ba29e8e73bbbf483f4e2d7",
        prior_pin: "ba546e7fd3492cb905c87792948a2fb384657e35f1dfbccd6e703959c7ef27a5",
        recognized_other_projects: 0,
        diff: {
          status: "changed",
          headline: "changed 2 lines",
          files: [
            {
              path: "SKILL.md",
              change: "modified",
              added: 1,
              removed: 1,
              lines: ["# Summarize", "- body", "+ body changed here"],
            },
          ],
          capped: false,
        },
      },
      {
        kind: "instruction",
        name: "house-rules",
        change: "unchanged",
        identity: "",
        runs: [],
        contacts: [],
        may_read: [],
        pin: "b62df69457befe282c7ed32bbba558789610714be4a22977a905621ae303309f",
        prior_pin: "b62df69457befe282c7ed32bbba558789610714be4a22977a905621ae303309f",
        recognized_other_projects: 0,
        diff: {
          status: "unchanged",
          headline: null,
          files: [],
          capped: false,
        },
      },
      {
        kind: "hook",
        name: "pre-commit",
        change: "unchanged",
        identity: "PreToolUse matching Bash runs ./scripts/check.sh --strict \u2192 *",
        runs: ["./scripts/check.sh --strict"],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "settings",
        name: "claude-code",
        change: "unchanged",
        identity: '{permissions:{allow:["Bash(git status)"]}}',
        runs: [],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
      {
        kind: "policy",
        name: "",
        change: "unchanged",
        identity: "\u00b7 egress docs: api.example.com",
        runs: [],
        contacts: [],
        may_read: [],
        pin: null,
        prior_pin: null,
        recognized_other_projects: null,
        diff: null,
      },
    ],
    removed: [],
  },
  schema_version: 1,
  features: [
    "init-plan",
    "apply-setup",
    "trust-preview",
    "trust-consent",
    "status-v1",
    "profiles-v1",
    "diff-v1",
    "restore-last",
    "sessions-v1",
    "profiles-edit-v1",
    "diff-ownership-v1",
    "toolset-create-v2",
    "profiles-edit-batch-v1",
    "toolset-rename-v1",
    "toolset-delete-v1",
    "library-remove-v1",
    "manifest-remove-v1",
    "trust-server-blockers-v1",
    "trust-review-card-v1",
    "trust-card-diff-v1",
    "activity-skill-load-v1",
    "workflow-observe-v1",
    "workflow-serial-roles-v1",
    "doctor-advisories-v1",
    "doctor-mode-v1",
    "doctor-probe-v1",
    "diff-existence-v1",
    "json-reads-v1",
    "gitignore-opt-out-v1",
    "doctor-cli-coverage-v1",
    "set-mode-v1",
    "status-honesty-v1",
  ],
};

describe("AgentstackTrustPreview", () => {
  it("decodes the trust-review-card-v1 fields the CLI actually emits", () => {
    const preview = decodePreview({
      path: "/work/project",
      state: "untrusted",
      re_trust: false,
      surface_digest: "sha256:5d0f6a11e934558511f6a634bdd3cde7f7685fa87777dc290fa81ecbeaebd528",
      servers: [
        { name: "github", kind: "stdio", target: "npx -y @modelcontextprotocol/server-github" },
      ],
      server_blockers: [],
      secrets: [],
      skills: [],
      workflows: [],
      extensions: [],
      instructions: [],
      hooks: [
        {
          name: "pre-commit",
          event: "pre-tool-use",
          matcher: null,
          runs: "./scripts/check.sh --fast",
          targets: ["claude-code"],
          executable: true,
        },
      ],
      settings: [{ adapter: "claude-code", sets: ["theme", "verbose"] }],
      policy_requested: ["· tools github: read_*"],
      machine_policy_ceiling: "/home/user/.agentstack/agentstack.toml",
      counts: { skills: 0, workflows: 0, extensions: 0, instructions: 0, hooks: 1, settings: 1 },
      schema_version: 1,
      features: ["trust-preview", "trust-review-card-v1"],
    });
    // The executable kind survives decode — the reason the contract exists.
    expect(preview.hooks?.[0]?.runs).toBe("./scripts/check.sh --fast");
    expect(preview.hooks?.[0]?.executable).toBe(true);
    expect(preview.settings?.[0]?.sets).toEqual(["theme", "verbose"]);
    expect(preview.policy_requested).toEqual(["· tools github: read_*"]);
    expect(preview.machine_policy_ceiling).toBe("/home/user/.agentstack/agentstack.toml");
    expect(preview.counts.hooks).toBe(1);
  });

  it("still decodes an older preview that predates the review card", () => {
    const preview = decodePreview({
      path: "/work/project",
      state: "trusted",
      re_trust: true,
      servers: [],
      secrets: [],
      counts: { skills: 0, workflows: 0, extensions: 0, instructions: 0 },
    });
    expect(preview.hooks).toBeUndefined();
    expect(preview.counts.hooks).toBeUndefined();
    // No `review` either — the field the consent card renders is absent, not
    // empty, so the panel's gate has something honest to degrade on.
    expect(preview.review).toBeUndefined();
  });

  it("decodes the whole trust-card-diff-v1 review, every kind the CLI emits", () => {
    const preview = decodePreview(PREVIEW_REGATE);
    const review = preview.review;
    expect(review?.re_review).toBe(true);
    expect(review?.prior_recorded).toBe(true);
    expect(review?.removed).toEqual([]);
    // All eleven rows survive, in the CLI's own order, with their kinds — a
    // kind the schema dropped is a kind the card can never show.
    expect(review?.items.map((i) => i.kind)).toEqual([
      "server",
      "server",
      "server",
      "secrets",
      "extension",
      "workflow",
      "skill",
      "instruction",
      "hook",
      "settings",
      "policy",
    ]);
    const server = review?.items[0];
    expect(server?.runs).toEqual(["npx -y @modelcontextprotocol/server-filesystem ."]);
    expect(review?.items[1]?.contacts).toEqual(["https://api.example.com/mcp/docs"]);
    expect(review?.items[3]?.may_read).toEqual(["DOCS_TOKEN"]);
    // The divergence the CLI documents and the panel must honour: only the
    // BYTES of this skill moved, so its identity — an inline skill's origin
    // word — still reads "unchanged" while the pins and the diff carry the
    // change. A consumer reading `change` alone would show nothing happened.
    const skill = review?.items[6];
    expect(skill).toMatchObject({ kind: "skill", name: "summarize", change: "unchanged" });
    expect(skill?.pin).not.toBe(skill?.prior_pin);
    expect(skill?.diff?.status).toBe("changed");
    expect(skill?.diff?.headline).toBe("changed 2 lines");
    expect(skill?.diff?.capped).toBe(false);
    expect(skill?.diff?.files[0]).toMatchObject({
      path: "SKILL.md",
      change: "modified",
      added: 1,
      removed: 1,
    });
    expect(skill?.diff?.files[0]?.lines).toEqual(["# Summarize", "- body", "+ body changed here"]);
    // Bare hex, not `sha256:`-prefixed — the machine's recognition index is
    // keyed on exactly this string.
    expect(skill?.pin).toMatch(/^[0-9a-f]{64}$/);
    expect(skill?.recognized_other_projects).toBe(0);
    // An unpinned kind carries a null diff rather than an empty one, so
    // "nothing to compare" and "compared, nothing moved" stay distinguishable.
    expect(server?.diff).toBeNull();
    expect(server?.pin).toBeNull();
    expect(review?.items[7]?.diff?.status).toBe("unchanged");
  });

  it("reads a never-approved project as all added, with no snapshot to diff", () => {
    // Trimmed from `preview-fresh.json` (same fixture, before any grant) to the
    // three rows that carry the property: prior_recorded is false, every mark
    // is `added`, and a pinned kind degrades to `no_snapshot` rather than
    // inventing a diff against nothing.
    const preview = decodePreview({
      path: "/work/project",
      state: "untrusted",
      re_trust: false,
      servers: [{ name: "filesystem", kind: "stdio", target: "npx -y server-filesystem ." }],
      secrets: ["DOCS_TOKEN"],
      counts: { skills: 1, workflows: 1, extensions: 1, instructions: 1 },
      review: {
        re_review: false,
        prior_recorded: false,
        items: [
          {
            kind: "server",
            name: "kibana",
            change: "added",
            identity:
              "library definition does not match the lockfile pin — run `agentstack lock`, review the change, and re-run the preview",
            runs: [],
            contacts: [],
            may_read: [],
            pin: null,
            prior_pin: null,
            recognized_other_projects: null,
            diff: null,
          },
          {
            kind: "skill",
            name: "summarize",
            change: "added",
            identity: "inline",
            runs: [],
            contacts: [],
            may_read: [],
            pin: null,
            prior_pin: null,
            recognized_other_projects: null,
            diff: { status: "no_snapshot", headline: null, files: [], capped: false },
          },
          {
            kind: "policy",
            name: "",
            change: "added",
            identity: "· egress docs: api.example.com",
            runs: [],
            contacts: [],
            may_read: [],
            pin: null,
            prior_pin: null,
            recognized_other_projects: null,
            diff: null,
          },
        ],
        removed: [],
      },
    });
    expect(preview.review?.prior_recorded).toBe(false);
    expect(preview.review?.items.every((i) => i.change === "added")).toBe(true);
    expect(preview.review?.items[1]?.diff).toEqual({
      status: "no_snapshot",
      headline: null,
      files: [],
      capped: false,
    });
    // A redacted library server keeps its name and its redaction sentence: the
    // row must still appear, or the surface reads smaller than it is.
    expect(preview.review?.items[0]?.name).toBe("kibana");
  });

  it("decodes a capped diff, whose counts stay exact while the lines go away", () => {
    // The cap hides detail, never scale. Shaped after the CLI's `pin_diff_json`
    // over-cap branch: `lines` null on every file, `capped` true, counts intact.
    const preview = decodePreview({
      path: "/work/project",
      state: "drifted",
      re_trust: true,
      servers: [],
      secrets: [],
      counts: { skills: 1, workflows: 0, extensions: 0, instructions: 0 },
      review: {
        re_review: true,
        prior_recorded: true,
        items: [
          {
            kind: "skill",
            name: "big",
            change: "unchanged",
            identity: "inline",
            runs: [],
            contacts: [],
            may_read: [],
            pin: "a".repeat(64),
            prior_pin: "b".repeat(64),
            recognized_other_projects: 3,
            diff: {
              status: "changed",
              headline: "changed 400 lines",
              files: [
                { path: "SKILL.md", change: "modified", added: 200, removed: 200, lines: null },
                { path: "extra.md", change: "added", added: 0, removed: 0, lines: null },
              ],
              capped: true,
            },
          },
        ],
        removed: [{ kind: "server", name: "gone", identity: "node gone.js" }],
      },
    });
    const diff = preview.review?.items[0]?.diff;
    expect(diff?.capped).toBe(true);
    expect(diff?.files[0]?.lines).toBeNull();
    expect(diff?.files[0]).toMatchObject({ added: 200, removed: 200 });
    expect(preview.review?.removed[0]).toEqual({
      kind: "server",
      name: "gone",
      identity: "node gone.js",
    });
    expect(preview.review?.items[0]?.recognized_other_projects).toBe(3);
  });
});

describe("AgentstackActivityEvent", () => {
  it("decodes the activity-skill-load-v1 feed the CLI actually emits", () => {
    // Verbatim `events` from `report calls --json --tail 20 --include-loads`
    // after driving the real binary's MCP server through one `agentstack_load`.
    const decoded = decodeEvents({
      events: [
        {
          kind: "skill_load",
          ts: 1785607989,
          name: "summarize",
          reason: "capturing the wire shape for the handoff",
          run: "r-capture",
          project:
            "/private/tmp/claude-608725469/-Users-tarek-k-Documents-GitHub-agentstack--claude-worktrees-quirky-mahavira-b4264d/55e0b910-5e83-42d6-b14b-67ce9a340b0f/scratchpad/captures/proj/.agentstack",
        },
      ],
    });
    const load = decoded.events[0];
    expect(load).toMatchObject({
      kind: "skill_load",
      name: "summarize",
      reason: "capturing the wire shape for the handoff",
      run: "r-capture",
    });
    // `project` rides along on a load row, exactly as it does on a call row —
    // dropping it would make the two feeds filterable by different rules.
    expect(load).toHaveProperty("project");
  });

  it("keeps kind-tagged and un-kinded call rows decoding as calls", () => {
    const decoded = decodeEvents({
      events: [
        // The pre-contract shape: no `kind` key at all. This is what every
        // older CLI emits, and what the CLI still emits without the flag.
        {
          ts: 1785606764,
          run: "r-capture",
          project: "/work/project",
          server: "figma",
          tool: "get_file",
          args_digest: "0123456789ab",
          outcome: "ok",
          ms: 42,
        },
        // The same row from a CLI serving the merged feed.
        {
          ts: 1785606765,
          server: "github",
          tool: "create_pr",
          outcome: "denied",
          ms: 0,
          detail: "policy.tools deny",
          kind: "call",
        },
      ],
    });
    expect(decoded.events[0]).toMatchObject({ server: "figma", tool: "get_file", outcome: "ok" });
    expect(decoded.events[0]).not.toHaveProperty("kind");
    expect(decoded.events[1]).toMatchObject({ kind: "call", outcome: "denied" });
  });

  it("decodes a load row that never had a project to record", () => {
    // The builtin-manual load path serves with no manifest directory at all,
    // so the key is omitted rather than emitted as an empty-string lie.
    const decoded = decodeEvents({
      events: [{ kind: "skill_load", ts: 1785606764, name: "manual", reason: "reading the docs" }],
    });
    expect(decoded.events[0]).not.toHaveProperty("project");
    expect(decoded.events[0]).not.toHaveProperty("run");
  });
});

describe("AgentstackDoctorReport", () => {
  it("decodes the status-honesty-v1 readiness verdict beside the older state", () => {
    const report = decodeDoctor({
      state: "ready",
      readiness: "never_activated",
      next_action: "agentstack use --write",
      protection: { guard: true, machine_policy: true },
      errors: 0,
      warnings: 0,
      sections: [],
    });
    // Both survive: `state` keeps its status-v1 meaning byte for byte, and
    // `readiness` is the field a panel renders instead.
    expect(report.state).toBe("ready");
    expect(report.readiness).toBe("never_activated");
  });

  it("still decodes a report that predates the verdict", () => {
    const report = decodeDoctor({ errors: 0, warnings: 0, sections: [] });
    expect(report.readiness).toBeUndefined();
  });
});
