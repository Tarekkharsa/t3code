import { memo } from "react";

import { cn } from "~/lib/utils";
import type { AgentstackParsedDiff } from "./agentstack-logic";

/**
 * A read-only unified diff, coloured and wrapped.
 *
 * Why this exists rather than `DiffPanel`: the host's diff pipeline renders
 * `FileDiffMetadata` through a worker pool, and AgentStack hands us
 * pre-rendered unified text with no hunk structure to rebuild it from. What the
 * screen actually needs is the part that was missing — a marker column and
 * add/delete colour.
 *
 * Wrapping, not scrolling. The previous `<pre>` gave every target its own
 * horizontal scrollbar inside an already-scrolling dialog, and clipped long
 * argv mid-token, so the one thing you came to read was the thing off-screen.
 */
export const DiffLines = memo(function DiffLines({
  parsed,
  className,
}: {
  parsed: AgentstackParsedDiff;
  className?: string;
}) {
  if (parsed.lines.length === 0) return null;
  return (
    <div className={cn("border-t border-border/50 bg-foreground/[0.02]", className)}>
      <div className="font-mono text-[10.5px] leading-[1.65]">
        {parsed.lines.map((line) => (
          <div
            key={line.key}
            className={cn(
              "grid grid-cols-[1.1rem_1fr]",
              line.kind === "add" && "bg-success/[0.09]",
              line.kind === "del" && "bg-destructive/[0.09]",
              line.kind === "hunk" && "bg-muted-foreground/[0.07]",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "select-none pl-2 text-center",
                line.kind === "add"
                  ? "text-success-foreground"
                  : line.kind === "del"
                    ? "text-destructive-foreground"
                    : "text-transparent",
              )}
            >
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            </span>
            <span
              className={cn(
                // `anywhere` and not `break-all`: a token only breaks when the
                // line cannot fit, so ordinary config text still breaks at
                // spaces and stays readable.
                "whitespace-pre-wrap pr-2.5 [overflow-wrap:anywhere]",
                line.kind === "add"
                  ? "text-success-foreground"
                  : line.kind === "del"
                    ? "text-destructive-foreground"
                    : line.kind === "hunk" || line.kind === "meta"
                      ? "text-muted-foreground/70"
                      : "text-muted-foreground",
              )}
            >
              {line.text}
            </span>
          </div>
        ))}
      </div>
      {parsed.truncated ? (
        <p className="border-t border-border/40 px-2.5 py-1.5 text-[10.5px] text-muted-foreground/70">
          Long diff — the rest is not shown. The counts above cover all of it.
        </p>
      ) : null}
    </div>
  );
});
