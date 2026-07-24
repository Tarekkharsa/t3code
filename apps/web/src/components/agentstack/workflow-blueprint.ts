/**
 * Workflow blueprint: the structured JSON a coding-CLI model emits (inside an
 * `agentstack-blueprint` fenced code block) to propose a workflow for review.
 *
 * The blueprint is HOSTILE INPUT — it arrives verbatim from a model's output
 * stream. Every function here parses defensively, bounds every size, and FAILS
 * CLOSED (returns null) on anything unexpected. `parseWorkflowBlueprint` never
 * throws; a null result means the chat renderer keeps the plain, inert code
 * block instead of drawing a review card.
 *
 * Schema is the authoritative one from docs/design/launch-plan.md section 6.
 * v1 caveats (accepted in the plan): `model`/`effort` are DECLARED INTENT
 * (advisory — the engine's real source of truth is the role profile); `fanout`
 * is a SYMBOLIC multiplicity string, never a fabricated concrete count.
 */

export const WORKFLOW_PATTERNS = [
  "map-reduce",
  "pipeline",
  "tournament",
  "loop-until-dry",
  "dag",
  "custom",
] as const;

export type WorkflowPattern = (typeof WORKFLOW_PATTERNS)[number];

export interface BlueprintNode {
  readonly id: string;
  readonly phase: string;
  readonly role: string;
  /** Declared intent (advisory in v1). */
  readonly model: string;
  /** Declared intent (advisory in v1). */
  readonly effort: string;
  readonly instruction: string;
  /** Symbolic multiplicity ("1 per changed file"), or null for a single spawn. */
  readonly fanout: string | null;
}

export interface BlueprintEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

export interface WorkflowBlueprint {
  readonly workflow: string;
  readonly pattern: WorkflowPattern;
  readonly goal: string;
  readonly nodes: ReadonlyArray<BlueprintNode>;
  readonly edges: ReadonlyArray<BlueprintEdge>;
}

/** Reject raw input larger than this (bytes) before ever calling JSON.parse. */
export const MAX_BLUEPRINT_RAW_BYTES = 64 * 1024;
const MAX_NODES = 32;
const MAX_EDGES = 64;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_STRING_CHARS = 200;

const PATTERN_SET: ReadonlySet<string> = new Set(WORKFLOW_PATTERNS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string that is present, non-empty after nothing (raw), and within `max`. */
function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** UTF-8 byte length, computed only after a cheap code-unit upper-bound reject. */
function withinRawByteLimit(raw: string): boolean {
  // A UTF-16 code unit is >= 1 UTF-8 byte, so if the code-unit count already
  // exceeds the limit the byte count certainly does; reject without encoding a
  // potentially enormous string. Otherwise the input is small enough that
  // encoding to measure exact bytes is cheap and bounded.
  if (raw.length > MAX_BLUEPRINT_RAW_BYTES) return false;
  return new TextEncoder().encode(raw).length <= MAX_BLUEPRINT_RAW_BYTES;
}

function parseNode(value: unknown): BlueprintNode | null {
  if (!isPlainObject(value)) return null;
  const { id, phase, role, model, effort, instruction, fanout } = value;
  if (!boundedString(id, MAX_STRING_CHARS) || id.length === 0) return null;
  if (!boundedString(phase, MAX_STRING_CHARS)) return null;
  if (!boundedString(role, MAX_STRING_CHARS)) return null;
  if (!boundedString(model, MAX_STRING_CHARS)) return null;
  if (!boundedString(effort, MAX_STRING_CHARS)) return null;
  if (!boundedString(instruction, MAX_INSTRUCTION_CHARS)) return null;
  if (fanout !== null && !boundedString(fanout, MAX_STRING_CHARS)) return null;
  return { id, phase, role, model, effort, instruction, fanout };
}

function parseEdge(value: unknown, nodeIds: ReadonlySet<string>): BlueprintEdge | null {
  if (!isPlainObject(value)) return null;
  const { from, to, kind } = value;
  if (!boundedString(from, MAX_STRING_CHARS) || !nodeIds.has(from)) return null;
  if (!boundedString(to, MAX_STRING_CHARS) || !nodeIds.has(to)) return null;
  if (!boundedString(kind, MAX_STRING_CHARS) || kind.length === 0) return null;
  return { from, to, kind };
}

/**
 * Parse a raw fenced-block body into a validated blueprint, or null. Never
 * throws — every failure mode (oversized input, invalid JSON, wrong shape,
 * out-of-range counts, duplicate/dangling node ids) returns null so the caller
 * falls back to an inert code block.
 */
export function parseWorkflowBlueprint(raw: string): WorkflowBlueprint | null {
  if (typeof raw !== "string") return null;
  if (!withinRawByteLimit(raw)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;

  const { workflow, pattern, goal, nodes, edges } = parsed;

  if (!boundedString(workflow, MAX_STRING_CHARS) || workflow.length === 0) return null;
  if (typeof pattern !== "string" || !PATTERN_SET.has(pattern)) return null;
  if (!boundedString(goal, MAX_STRING_CHARS)) return null;

  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) return null;

  const parsedNodes: BlueprintNode[] = [];
  const nodeIds = new Set<string>();
  for (const rawNode of nodes) {
    const node = parseNode(rawNode);
    if (node === null) return null;
    if (nodeIds.has(node.id)) return null; // duplicate id
    nodeIds.add(node.id);
    parsedNodes.push(node);
  }

  // Edges are optional (a single-node workflow has none) but bounded.
  if (edges !== undefined && !Array.isArray(edges)) return null;
  const rawEdges: ReadonlyArray<unknown> = Array.isArray(edges) ? edges : [];
  if (rawEdges.length > MAX_EDGES) return null;

  const parsedEdges: BlueprintEdge[] = [];
  for (const rawEdge of rawEdges) {
    const edge = parseEdge(rawEdge, nodeIds);
    if (edge === null) return null;
    parsedEdges.push(edge);
  }

  return {
    workflow,
    pattern: pattern as WorkflowPattern,
    goal,
    nodes: parsedNodes,
    edges: parsedEdges,
  };
}

/*
 * Review-action message templates.
 *
 * These are the EXACT plain-text user messages the review card sends back into
 * the thread. They are the interlock contract with the coding-CLI skill: the
 * skill recognizes these three shapes to know whether to run, cancel, or revise
 * the blueprint. Keep them byte-for-byte in sync with the skill
 * (agentstack: crates/cli/catalog/skills/propose-workflow/SKILL.md §3).
 */

export function blueprintApproveMessage(workflow: string): string {
  return `Approved: run workflow blueprint "${workflow}" exactly as shown.`;
}

export function blueprintRejectMessage(workflow: string): string {
  return `Rejected: cancel workflow blueprint "${workflow}". Do not run it.`;
}

export function blueprintEditMessage(workflow: string, changeRequest: string): string {
  return `Edit workflow blueprint "${workflow}": ${changeRequest}`;
}
