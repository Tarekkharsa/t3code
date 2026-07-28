import { CheckIcon, PencilIcon, SendHorizontalIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { AgentstackMark } from "./AgentstackMark";
import { blueprintToMermaid } from "./blueprint-mermaid";
import { BlueprintGraph } from "./BlueprintGraph";
import {
  blueprintApproveMessage,
  blueprintEditMessage,
  blueprintRejectMessage,
  type BlueprintNode,
  type WorkflowBlueprint,
} from "./workflow-blueprint";

/**
 * In-band review card for a workflow blueprint a coding-CLI model proposed.
 *
 * Nothing here executes a workflow: the three actions each send an EXACT
 * plain-text user message back into the same thread (via `onSendUserMessage`),
 * and the model — which authored the blueprint and is waiting — does the
 * running. Approve/Reject send immediately; Edit reveals a textarea and sends
 * the change request. All actions are disabled while the assistant message is
 * still streaming, or when no send channel is wired (e.g. non-chat previews).
 */

interface BlueprintReviewCardProps {
  blueprint: WorkflowBlueprint;
  theme: "light" | "dark";
  isStreaming: boolean;
  onSendUserMessage?: ((text: string) => void) | undefined;
}

function NodeDetail({ node }: { node: BlueprintNode }) {
  return (
    <li className="rounded-lg border border-border/40 bg-foreground/[0.02] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-medium text-foreground/80">
          {node.phase}
        </span>
        <span className="font-mono text-muted-foreground">{node.role}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="font-mono text-muted-foreground">{node.model}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="font-mono text-muted-foreground">{node.effort}</span>
        {node.fanout !== null ? (
          <span className="rounded bg-primary/[0.08] px-1.5 py-0.5 font-mono text-[10.5px] text-primary">
            ×{node.fanout}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-foreground/70">{node.instruction}</p>
    </li>
  );
}

export function BlueprintReviewCard({
  blueprint,
  theme,
  isStreaming,
  onSendUserMessage,
}: BlueprintReviewCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const mermaidText = useMemo(() => blueprintToMermaid(blueprint), [blueprint]);

  const canAct = !isStreaming && typeof onSendUserMessage === "function";
  const send = (text: string) => {
    if (!canAct || onSendUserMessage === undefined) return;
    onSendUserMessage(text);
  };

  const onApprove = () => send(blueprintApproveMessage(blueprint.workflow));
  const onReject = () => send(blueprintRejectMessage(blueprint.workflow));
  const onSubmitEdit = () => {
    const trimmed = editText.trim();
    if (trimmed.length === 0) return;
    send(blueprintEditMessage(blueprint.workflow, trimmed));
    setEditText("");
    setEditing(false);
  };

  const disabledTitle = isStreaming
    ? "Wait for the response to finish."
    : "Reviewing is only available in a live chat thread.";

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border/60 bg-foreground/[0.015]">
      <div className="flex items-center gap-2 border-b border-border/50 px-3.5 py-2.5">
        <AgentstackMark className="size-[15px] shrink-0 text-primary" />
        <span className="font-semibold text-[13px] text-foreground">{blueprint.workflow}</span>
        <span className="rounded-full border border-primary/30 bg-primary/[0.08] px-2 py-0.5 font-mono text-[10.5px] text-primary">
          {blueprint.pattern}
        </span>
        <span className="ml-auto text-[10.5px] text-muted-foreground/70">workflow blueprint</span>
      </div>

      <p className="px-3.5 pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
        {blueprint.goal}
      </p>

      <div className="px-3.5 py-3">
        <BlueprintGraph mermaidText={mermaidText} theme={theme} />
      </div>

      <ul className="flex flex-col gap-1.5 px-3.5 pb-3">
        {blueprint.nodes.map((node) => (
          <NodeDetail key={node.id} node={node} />
        ))}
      </ul>

      {/*
        What Approve actually does, said BEFORE the button rather than
        discovered after it. It is not "run this": the model declares the
        workflow — pinning this graph beside the script it writes, so changing
        either one re-gates — and the user still reviews the real bytes at the
        trust step. Leaving that implicit is what made the later consent prompt
        read as duplicate ceremony, which is how a gate gets clicked through
        (review finding F13). Stated without over-claiming: the pin binds the
        two artifacts, it does not prove the code implements the graph.
      */}
      <p className="border-t border-border/50 px-3.5 pt-2.5 text-[11.5px] leading-relaxed text-muted-foreground/80">
        Approving does not run it. The model writes the workflow and pins this graph together with
        the script, then{" "}
        <strong className="font-medium text-foreground/80">you review the real code</strong> before
        anything executes — changing either one asks you again. The graph shows the intended shape;
        it is not proof the code matches it.
      </p>

      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="default"
            disabled={!canAct}
            title={canAct ? undefined : disabledTitle}
            onClick={onApprove}
          >
            <CheckIcon />
            Approve
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canAct}
            title={canAct ? undefined : disabledTitle}
            onClick={onReject}
          >
            <XIcon />
            Reject
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canAct}
            title={canAct ? undefined : disabledTitle}
            onClick={() => setEditing((value) => !value)}
          >
            <PencilIcon />
            Edit with the model
          </Button>
        </div>

        {editing && canAct ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-background/60 p-2">
            <textarea
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              rows={3}
              autoFocus
              placeholder="Describe the change you want (e.g. add a validation step before the reduce)…"
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  onSubmitEdit();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="default"
                disabled={editText.trim().length === 0}
                onClick={onSubmitEdit}
              >
                <SendHorizontalIcon />
                Send change
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
