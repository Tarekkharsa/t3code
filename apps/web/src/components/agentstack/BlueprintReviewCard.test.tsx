/**
 * What the blueprint review card CLAIMS, asserted on rendered output.
 *
 * The card sits in front of a consent decision, so its copy is part of the
 * security surface, not decoration. Two things must hold and neither is
 * checkable by reading the graph: it must not imply Approve executes anything,
 * and it must not imply the pinned graph proves the generated code matches it
 * (review finding F13 — the pin binds the two artifacts, nothing verifies
 * faithfulness). Both are easy to lose in a copy edit, so they are pinned here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BlueprintReviewCard } from "./BlueprintReviewCard";
import type { WorkflowBlueprint } from "./workflow-blueprint";

const BLUEPRINT: WorkflowBlueprint = {
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

function render(overrides?: { isStreaming?: boolean }) {
  return renderToStaticMarkup(
    <BlueprintReviewCard
      blueprint={BLUEPRINT}
      theme="light"
      isStreaming={overrides?.isStreaming ?? false}
      onSendUserMessage={() => {}}
    />,
  );
}

describe("BlueprintReviewCard", () => {
  it("says Approve does not execute, and that review still comes after", () => {
    const markup = render();
    expect(markup).toContain("Approving does not run it");
    // The later trust step must be promised here, or that gate reads as a
    // duplicate confirmation and gets clicked through.
    expect(markup).toContain("you review the real code");
    expect(markup).toContain("changing either one asks you again");
  });

  it("does not claim the pinned graph proves the code matches it", () => {
    const markup = render();
    expect(markup).toContain("not proof the code matches it");
  });

  it("still shows the shape being approved", () => {
    const markup = render();
    expect(markup).toContain("repo-audit");
    expect(markup).toContain("map-reduce");
    expect(markup).toContain("Find and rank bugs across the changed files");
    // Per-node declared intent is the reviewable judgement.
    expect(markup).toContain("reviewer");
    expect(markup).toContain("1 per changed file");
  });

  it("disables every action while the model is still streaming", () => {
    // Acting on a half-emitted blueprint would approve a graph the model has
    // not finished drawing.
    const markup = render({ isStreaming: true });
    const disabled = markup.split("disabled").length - 1;
    expect(disabled).toBeGreaterThanOrEqual(3);
  });
});
