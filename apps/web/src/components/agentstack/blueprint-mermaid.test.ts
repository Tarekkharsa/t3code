import { describe, expect, it } from "vite-plus/test";

import { blueprintToMermaid } from "./blueprint-mermaid";
import type { WorkflowBlueprint } from "./workflow-blueprint";

const MAP_REDUCE: WorkflowBlueprint = {
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
};

const MAP_REDUCE_MERMAID = [
  "flowchart TD",
  '  subgraph p0["Find"]',
  '    n0["reviewer<br/>gpt-5.5 · low<br/>×1 per changed file"]',
  "  end",
  '  subgraph p1["Rank"]',
  '    n1["synthesizer<br/>opus · high"]',
  "  end",
  '  n0 -->|"fan-in"| n1',
].join("\n");

const TOURNAMENT: WorkflowBlueprint = {
  workflow: "design-api",
  pattern: "tournament",
  goal: "Produce the best API design from competing attempts",
  nodes: [
    {
      id: "attempt",
      phase: "Generate",
      role: "designer",
      model: "opus",
      effort: "high",
      instruction: "Design the API from a distinct angle (given by index)",
      fanout: "3 attempts",
    },
    {
      id: "judge",
      phase: "Score",
      role: "judge",
      model: "fable",
      effort: "high",
      instruction: "Score every attempt on clarity, safety, ergonomics",
      fanout: "1 per attempt",
    },
    {
      id: "synth",
      phase: "Synthesize",
      role: "synthesizer",
      model: "opus",
      effort: "high",
      instruction: "Build the final design from the winner + best grafts",
      fanout: null,
    },
  ],
  edges: [
    { from: "attempt", to: "judge", kind: "fan-out-then-score" },
    { from: "judge", to: "synth", kind: "fan-in" },
  ],
};

const TOURNAMENT_MERMAID = [
  "flowchart TD",
  '  subgraph p0["Generate"]',
  '    n0["designer<br/>opus · high<br/>×3 attempts"]',
  "  end",
  '  subgraph p1["Score"]',
  '    n1["judge<br/>fable · high<br/>×1 per attempt"]',
  "  end",
  '  subgraph p2["Synthesize"]',
  '    n2["synthesizer<br/>opus · high"]',
  "  end",
  '  n0 -->|"fan-out-then-score"| n1',
  '  n1 -->|"fan-in"| n2',
].join("\n");

describe("blueprintToMermaid", () => {
  it("renders the map-reduce worked example exactly", () => {
    expect(blueprintToMermaid(MAP_REDUCE)).toBe(MAP_REDUCE_MERMAID);
  });

  it("renders the tournament worked example exactly", () => {
    expect(blueprintToMermaid(TOURNAMENT)).toBe(TOURNAMENT_MERMAID);
  });

  it("is deterministic — identical output across calls", () => {
    expect(blueprintToMermaid(MAP_REDUCE)).toBe(blueprintToMermaid(MAP_REDUCE));
    expect(blueprintToMermaid(TOURNAMENT)).toBe(blueprintToMermaid(TOURNAMENT));
  });

  it("groups nodes into one subgraph per distinct phase, in first-appearance order", () => {
    const bp: WorkflowBlueprint = {
      workflow: "w",
      pattern: "dag",
      goal: "g",
      nodes: [
        {
          id: "a",
          phase: "Beta",
          role: "r",
          model: "m",
          effort: "e",
          instruction: "i",
          fanout: null,
        },
        {
          id: "b",
          phase: "Alpha",
          role: "r",
          model: "m",
          effort: "e",
          instruction: "i",
          fanout: null,
        },
        {
          id: "c",
          phase: "Beta",
          role: "r",
          model: "m",
          effort: "e",
          instruction: "i",
          fanout: null,
        },
      ],
      edges: [],
    };
    const out = blueprintToMermaid(bp);
    // Beta appears first, and both Beta nodes share the same subgraph.
    expect(out).toBe(
      [
        "flowchart TD",
        '  subgraph p0["Beta"]',
        '    n0["r<br/>m · e"]',
        '    n2["r<br/>m · e"]',
        "  end",
        '  subgraph p1["Alpha"]',
        '    n1["r<br/>m · e"]',
        "  end",
      ].join("\n"),
    );
  });

  it("neutralizes hostile text inside quoted labels", () => {
    const bp: WorkflowBlueprint = {
      workflow: "evil",
      pattern: "custom",
      goal: "g",
      nodes: [
        {
          id: 'x"] click n0 callback',
          phase: '%%{init:{"theme":"dark"}}%%',
          role: 'a"]-->z{{pwn}}',
          model: "`backtick`",
          effort: "e<script>",
          instruction: "i",
          fanout: "1\nper\nfile",
        },
      ],
      edges: [],
    };
    const out = blueprintToMermaid(bp);
    // No raw double quote, backtick, angle bracket, or bare '#' survives.
    // (Quotes only ever appear as our own structural `["` / `"]` delimiters.)
    const labelBodies = out
      .split("\n")
      .filter((line) => line.includes('["'))
      .map((line) => line.slice(line.indexOf('["') + 2, line.lastIndexOf('"]')))
      // Strip the ONLY markup we intentionally emit — the <br/> line separators
      // — so the remaining text is purely (escaped) hostile content.
      .map((body) => body.split("<br/>").join(""));
    for (const body of labelBodies) {
      expect(body).not.toContain('"');
      expect(body).not.toContain("`");
      expect(body).not.toContain("<");
      expect(body).not.toContain(">");
      // Every '#' must belong to an `&#NN;` numeric entity we emitted — never a
      // bare '#' that Mermaid could read as an entity-code escape.
      const withoutEntities = body.replace(/&#\d+;/g, "").replace(/&(?:amp|lt|gt|quot);/g, "");
      expect(withoutEntities).not.toContain("#");
    }
    // Hostile text only ever survives as escaped content INSIDE a quoted label,
    // never as its own Mermaid statement: the node id is not emitted verbatim
    // (synthetic `n0` is used), and no line stands alone as a `%%` directive or
    // a `click` interaction statement.
    for (const line of out.split("\n")) {
      const trimmed = line.trimStart();
      expect(trimmed.startsWith("%%")).toBe(false);
      expect(trimmed.startsWith("click ")).toBe(false);
    }
    // The raw node id text is never present anywhere in the source.
    expect(out).not.toContain("callback");
    // Newlines in fanout collapse to spaces — never terminate a statement.
    expect(out).toContain("×1 per file");
  });

  it("omits the multiplier line when fanout is null", () => {
    const bp: WorkflowBlueprint = {
      workflow: "w",
      pattern: "pipeline",
      goal: "g",
      nodes: [
        { id: "a", phase: "P", role: "r", model: "m", effort: "e", instruction: "i", fanout: null },
      ],
      edges: [],
    };
    expect(blueprintToMermaid(bp)).toBe(
      ["flowchart TD", '  subgraph p0["P"]', '    n0["r<br/>m · e"]', "  end"].join("\n"),
    );
  });
});
