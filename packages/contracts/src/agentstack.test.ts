import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AgentstackDoctorReport, AgentstackTrustPreview } from "./agentstack.ts";

// Decode witnesses against REAL payloads captured from `agentstack trust
// --preview` / `doctor --json` (agentstack 0.18.0-rc, 2026-08-01), trimmed to
// the fields under test plus enough context to stay honest. The panel's whole
// negotiation model rests on these shapes surviving decode: a field the schema
// silently drops is a field no feature gate can ever render.

const decodePreview = Schema.decodeUnknownSync(AgentstackTrustPreview);
const decodeDoctor = Schema.decodeUnknownSync(AgentstackDoctorReport);

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
