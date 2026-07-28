/**
 * Thin, deterministic blueprint -> Mermaid flowchart renderer.
 *
 * This is a small pure function, NOT a graph engine: the same blueprint always
 * produces byte-identical Mermaid source. It only lays out topology; the actual
 * SVG rendering (and its `securityLevel: "strict"` sandbox) happens in
 * BlueprintGraph.
 *
 * Blueprint text is HOSTILE. Node ids are never emitted into the Mermaid source
 * verbatim — each node maps to a synthetic id (`n<index>`), each phase to a
 * synthetic subgraph id (`p<index>`) — so a crafted id cannot inject Mermaid
 * syntax. All human-visible text goes through `escapeLabel`, which quotes and
 * entity-escapes every character that could break out of a quoted label or be
 * reinterpreted by Mermaid (quotes, backticks, angle brackets, ampersands,
 * `#` entity codes, newlines). Labels are wrapped in double quotes so Mermaid
 * treats their contents as literal text; the only markup we intentionally emit
 * is the `<br/>` line separator, which the escaped content can never forge.
 */

import type { WorkflowBlueprint } from "./workflow-blueprint";

const LINE_BREAK = "<br/>";

const LABEL_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "`": "&#96;",
  "#": "&#35;",
};

/**
 * Neutralize a hostile string for use inside a double-quoted Mermaid label.
 * Whitespace collapses to a single space first (so it cannot terminate a
 * Mermaid statement), then every reserved character is replaced in a SINGLE
 * pass. A single pass is essential: the entities we introduce (e.g. `&#96;`)
 * themselves contain `&` and `#`, so a sequence of `.replace` calls would
 * re-escape them and corrupt the output.
 */
function escapeLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/[&<>"`#]/g, (ch) => LABEL_ENTITIES[ch] ?? ch);
}

/** Build the multi-line, escaped label for one node. */
function nodeLabel(role: string, model: string, effort: string, fanout: string | null): string {
  const lines = [escapeLabel(role), `${escapeLabel(model)} · ${escapeLabel(effort)}`];
  if (fanout !== null) {
    lines.push(`×${escapeLabel(fanout)}`);
  }
  return lines.join(LINE_BREAK);
}

/**
 * Render a validated blueprint to deterministic Mermaid flowchart source.
 * Nodes are grouped into subgraphs by phase in order of first appearance;
 * edges are emitted after all subgraphs with the edge kind as the label.
 */
export function blueprintToMermaid(bp: WorkflowBlueprint): string {
  const lines: string[] = ["flowchart TD"];

  // Assign synthetic node ids by array order.
  const nodeIdToSynthetic = new Map<string, string>();
  bp.nodes.forEach((node, index) => {
    nodeIdToSynthetic.set(node.id, `n${index}`);
  });

  // Group node indexes by phase, preserving first-appearance order of phases.
  const phaseOrder: string[] = [];
  const nodeIndexesByPhase = new Map<string, number[]>();
  bp.nodes.forEach((node, index) => {
    let bucket = nodeIndexesByPhase.get(node.phase);
    if (bucket === undefined) {
      bucket = [];
      nodeIndexesByPhase.set(node.phase, bucket);
      phaseOrder.push(node.phase);
    }
    bucket.push(index);
  });

  phaseOrder.forEach((phase, phaseIndex) => {
    lines.push(`  subgraph p${phaseIndex}["${escapeLabel(phase)}"]`);
    const bucket = nodeIndexesByPhase.get(phase) ?? [];
    for (const nodeIndex of bucket) {
      const node = bp.nodes[nodeIndex]!;
      const label = nodeLabel(node.role, node.model, node.effort, node.fanout);
      lines.push(`    n${nodeIndex}["${label}"]`);
    }
    lines.push("  end");
  });

  for (const edge of bp.edges) {
    const from = nodeIdToSynthetic.get(edge.from);
    const to = nodeIdToSynthetic.get(edge.to);
    // parseWorkflowBlueprint guarantees both endpoints exist; guard anyway so
    // this pure function never emits a dangling reference.
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} -->|"${escapeLabel(edge.kind)}"| ${to}`);
  }

  return lines.join("\n");
}
