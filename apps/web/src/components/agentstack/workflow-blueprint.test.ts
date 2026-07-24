import { describe, expect, it } from "vite-plus/test";

import {
  blueprintApproveMessage,
  blueprintEditMessage,
  blueprintRejectMessage,
  MAX_BLUEPRINT_RAW_BYTES,
  parseWorkflowBlueprint,
  type WorkflowBlueprint,
} from "./workflow-blueprint";

const MAP_REDUCE_JSON = JSON.stringify({
  workflow: "repo-audit",
  pattern: "map-reduce",
  goal: "Find and rank bugs across the changed files",
  nodes: [
    {
      id: "map",
      phase: "Find",
      role: "reviewer",
      model: "gpt-5.5",
      effort: "low",
      instruction: "Scan ONE changed file for correctness bugs",
      fanout: "1 per changed file",
    },
    {
      id: "reduce",
      phase: "Rank",
      role: "synthesizer",
      model: "opus",
      effort: "high",
      instruction: "Dedupe and rank all findings by severity",
      fanout: null,
    },
  ],
  edges: [{ from: "map", to: "reduce", kind: "fan-in" }],
});

describe("parseWorkflowBlueprint", () => {
  it("accepts the map-reduce worked example", () => {
    const bp = parseWorkflowBlueprint(MAP_REDUCE_JSON);
    expect(bp).not.toBeNull();
    const value = bp as WorkflowBlueprint;
    expect(value.workflow).toBe("repo-audit");
    expect(value.pattern).toBe("map-reduce");
    expect(value.nodes.length).toBe(2);
    expect(value.nodes[0]?.fanout).toBe("1 per changed file");
    expect(value.nodes[1]?.fanout).toBeNull();
    expect(value.edges).toEqual([{ from: "map", to: "reduce", kind: "fan-in" }]);
  });

  it("accepts a single-node workflow with no edges", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "solo",
        pattern: "custom",
        goal: "Do one thing",
        nodes: [
          {
            id: "only",
            phase: "Work",
            role: "worker",
            model: "opus",
            effort: "high",
            instruction: "Just do it",
            fanout: null,
          },
        ],
      }),
    );
    expect(bp).not.toBeNull();
    expect((bp as WorkflowBlueprint).edges).toEqual([]);
  });

  it("accepts every declared pattern", () => {
    for (const pattern of [
      "map-reduce",
      "pipeline",
      "tournament",
      "loop-until-dry",
      "dag",
      "custom",
    ]) {
      const bp = parseWorkflowBlueprint(
        JSON.stringify({
          workflow: "w",
          pattern,
          goal: "g",
          nodes: [
            {
              id: "a",
              phase: "P",
              role: "r",
              model: "m",
              effort: "e",
              instruction: "i",
              fanout: null,
            },
          ],
        }),
      );
      expect(bp, `pattern ${pattern}`).not.toBeNull();
    }
  });

  it("never throws and returns null on invalid JSON", () => {
    expect(parseWorkflowBlueprint("{ not json")).toBeNull();
    expect(parseWorkflowBlueprint("")).toBeNull();
    expect(parseWorkflowBlueprint("   ")).toBeNull();
    expect(parseWorkflowBlueprint("42")).toBeNull();
    expect(parseWorkflowBlueprint('"a string"')).toBeNull();
    expect(parseWorkflowBlueprint("null")).toBeNull();
    expect(parseWorkflowBlueprint("[]")).toBeNull();
  });

  it("rejects unknown patterns", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "mega-swarm",
        goal: "g",
        nodes: [
          {
            id: "a",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
        ],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects missing or empty required strings", () => {
    const base = {
      workflow: "w",
      pattern: "custom",
      goal: "g",
      nodes: [
        { id: "a", phase: "P", role: "r", model: "m", effort: "e", instruction: "i", fanout: null },
      ],
    };
    expect(parseWorkflowBlueprint(JSON.stringify({ ...base, workflow: "" }))).toBeNull();
    expect(parseWorkflowBlueprint(JSON.stringify({ ...base, workflow: 5 }))).toBeNull();
    expect(parseWorkflowBlueprint(JSON.stringify({ ...base, goal: 5 }))).toBeNull();
    expect(parseWorkflowBlueprint(JSON.stringify({ ...base, pattern: 5 }))).toBeNull();
  });

  it("rejects an empty or missing nodes array", () => {
    expect(
      parseWorkflowBlueprint(
        JSON.stringify({ workflow: "w", pattern: "custom", goal: "g", nodes: [] }),
      ),
    ).toBeNull();
    expect(
      parseWorkflowBlueprint(JSON.stringify({ workflow: "w", pattern: "custom", goal: "g" })),
    ).toBeNull();
  });

  it("rejects duplicate node ids", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          {
            id: "a",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
          {
            id: "a",
            phase: "Q",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
        ],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects an edge that references a non-existent node", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          {
            id: "a",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
        ],
        edges: [{ from: "a", to: "ghost", kind: "next" }],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects an edge with an empty kind", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          {
            id: "a",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
          {
            id: "b",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
        ],
        edges: [{ from: "a", to: "b", kind: "" }],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects a node with an empty id", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          {
            id: "",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
        ],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects a node with a non-string / non-null fanout", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          { id: "a", phase: "P", role: "r", model: "m", effort: "e", instruction: "i", fanout: 3 },
        ],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects more than 32 nodes", () => {
    const nodes = Array.from({ length: 33 }, (_, i) => ({
      id: `n${i}`,
      phase: "P",
      role: "r",
      model: "m",
      effort: "e",
      instruction: "i",
      fanout: null,
    }));
    expect(
      parseWorkflowBlueprint(
        JSON.stringify({ workflow: "w", pattern: "custom", goal: "g", nodes }),
      ),
    ).toBeNull();
  });

  it("rejects more than 64 edges", () => {
    const edges = Array.from({ length: 65 }, () => ({ from: "a", to: "b", kind: "k" }));
    expect(
      parseWorkflowBlueprint(
        JSON.stringify({
          workflow: "w",
          pattern: "custom",
          goal: "g",
          nodes: [
            {
              id: "a",
              phase: "P",
              role: "r",
              model: "m",
              effort: "e",
              instruction: "i",
              fanout: null,
            },
            {
              id: "b",
              phase: "P",
              role: "r",
              model: "m",
              effort: "e",
              instruction: "i",
              fanout: null,
            },
          ],
          edges,
        }),
      ),
    ).toBeNull();
  });

  it("rejects an over-long instruction", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          {
            id: "a",
            phase: "P",
            role: "r",
            model: "m",
            effort: "e",
            instruction: "x".repeat(2001),
            fanout: null,
          },
        ],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects an over-long non-instruction string", () => {
    const bp = parseWorkflowBlueprint(
      JSON.stringify({
        workflow: "w",
        pattern: "custom",
        goal: "g",
        nodes: [
          {
            id: "a",
            phase: "P",
            role: "x".repeat(201),
            model: "m",
            effort: "e",
            instruction: "i",
            fanout: null,
          },
        ],
      }),
    );
    expect(bp).toBeNull();
  });

  it("rejects raw input larger than the byte guard before parsing", () => {
    const huge = " ".repeat(MAX_BLUEPRINT_RAW_BYTES + 1);
    expect(parseWorkflowBlueprint(huge)).toBeNull();
  });

  it("rejects multibyte input under the code-unit limit but over the byte limit", () => {
    // Each "😀" is a surrogate pair: 2 UTF-16 code units, 4 UTF-8 bytes. 20,000
    // copies keep `raw.length` well under the guard while pushing the actual
    // UTF-8 byte count past it, so this can only be caught by the
    // TextEncoder fallback in withinRawByteLimit, not the code-unit
    // short-circuit that precedes it.
    const emoji = "😀".repeat(20000);
    const raw = JSON.stringify({
      workflow: "w",
      pattern: "custom",
      goal: "g",
      nodes: [
        {
          id: "a",
          phase: "P",
          role: "r",
          model: "m",
          effort: "e",
          instruction: emoji,
          fanout: null,
        },
      ],
    });
    expect(raw.length).toBeLessThanOrEqual(MAX_BLUEPRINT_RAW_BYTES);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(MAX_BLUEPRINT_RAW_BYTES);
    expect(parseWorkflowBlueprint(raw)).toBeNull();
  });

  it("ignores __proto__/constructor keys instead of polluting Object.prototype", () => {
    // Written as a raw JSON string (not a JS object literal) so "__proto__"
    // lands as a genuine JSON key that JSON.parse turns into an own
    // enumerable data property — the classic prototype-pollution vector for
    // code that walks unknown keys. This parser only ever reads named
    // properties it destructures explicitly, so these keys should be
    // silently ignored rather than reaching Object.prototype.
    const raw =
      '{"__proto__":{"polluted":true},"workflow":"w","pattern":"custom","goal":"g",' +
      '"nodes":[{"__proto__":{"polluted":true},"constructor":{"polluted":true},' +
      '"id":"a","phase":"P","role":"r","model":"m","effort":"e","instruction":"i","fanout":null}]}';

    const bp = parseWorkflowBlueprint(raw);

    expect(bp).not.toBeNull();
    const value = bp as WorkflowBlueprint;
    expect(value.workflow).toBe("w");
    expect(value.nodes.length).toBe(1);
    expect((value as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect((value.nodes[0] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("blueprint review message templates", () => {
  it("builds the exact Approve message", () => {
    expect(blueprintApproveMessage("repo-audit")).toBe(
      'Approved: run workflow blueprint "repo-audit" exactly as shown.',
    );
  });

  it("builds the exact Reject message", () => {
    expect(blueprintRejectMessage("repo-audit")).toBe(
      'Rejected: cancel workflow blueprint "repo-audit". Do not run it.',
    );
  });

  it("builds the exact Edit message with the change request appended", () => {
    expect(blueprintEditMessage("repo-audit", "add a validation step")).toBe(
      'Edit workflow blueprint "repo-audit": add a validation step',
    );
  });
});
