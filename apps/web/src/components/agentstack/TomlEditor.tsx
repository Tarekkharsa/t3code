import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";

/**
 * One classified run of TOML source, for colouring.
 *
 * Display only. A run that tokenizes wrongly renders in the wrong colour and
 * nothing else — the textarea below holds the real bytes and is what gets
 * saved, so a highlighter bug can never corrupt a manifest.
 */
type TomlToken = { readonly text: string; readonly kind: TomlTokenKind };
type TomlTokenKind = "comment" | "table" | "key" | "string" | "number" | "boolean" | "plain";

const TOKEN_CLASS: Record<TomlTokenKind, string> = {
  // Deliberately the same semantic tokens the rest of the panel uses rather
  // than a private palette, so the editor tracks the app's theme for free.
  comment: "text-muted-foreground/60 italic",
  table: "font-semibold text-warning-foreground",
  key: "text-foreground",
  string: "text-success-foreground",
  number: "text-destructive-foreground",
  boolean: "text-destructive-foreground",
  plain: "text-muted-foreground",
};

/** `"…"` or `'…'`, honouring backslash escapes in the double-quoted form. */
const STRING_RE = /^("(?:[^"\\]|\\.)*"?|'[^']*'?)/;
const NUMBER_RE = /^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/;
const BOOLEAN_RE = /^(?:true|false)\b/;
const BARE_KEY_RE = /^[A-Za-z0-9_.-]+/;

/**
 * Split one line of TOML into coloured runs.
 *
 * Line-at-a-time on purpose: TOML has no construct that changes the meaning of
 * a later line the way an unterminated block comment would, so a line is a
 * complete unit and the whole file never needs re-tokenizing to draw one of
 * them. Multi-line basic strings are the exception, and they degrade to
 * `plain` rather than to a wrong colour.
 */
export function tokenizeTomlLine(line: string): ReadonlyArray<TomlToken> {
  const tokens: TomlToken[] = [];
  let rest = line;
  let atLineStart = true;

  const push = (text: string, kind: TomlTokenKind) => {
    if (text.length > 0) tokens.push({ text, kind });
  };

  while (rest.length > 0) {
    const leading = /^\s+/.exec(rest);
    if (leading) {
      push(leading[0], "plain");
      rest = rest.slice(leading[0].length);
      continue;
    }
    if (rest.startsWith("#")) {
      push(rest, "comment");
      break;
    }
    if (atLineStart && rest.startsWith("[")) {
      // A table header owns the whole line up to any trailing comment.
      const end = rest.indexOf("]");
      const header = end === -1 ? rest : rest.slice(0, end + 1);
      push(header, "table");
      rest = rest.slice(header.length);
      atLineStart = false;
      continue;
    }
    const str = STRING_RE.exec(rest);
    if (str) {
      push(str[0], "string");
      rest = rest.slice(str[0].length);
      atLineStart = false;
      continue;
    }
    const bool = BOOLEAN_RE.exec(rest);
    if (bool) {
      push(bool[0], "boolean");
      rest = rest.slice(bool[0].length);
      atLineStart = false;
      continue;
    }
    const num = NUMBER_RE.exec(rest);
    if (num) {
      push(num[0], "number");
      rest = rest.slice(num[0].length);
      atLineStart = false;
      continue;
    }
    const bare = BARE_KEY_RE.exec(rest);
    if (bare) {
      // A bare word is a key only before the `=`; after it, it is a value.
      push(bare[0], atLineStart ? "key" : "plain");
      rest = rest.slice(bare[0].length);
      atLineStart = false;
      continue;
    }
    push(rest[0] ?? "", "plain");
    rest = rest.slice(1);
    atLineStart = false;
  }
  return tokens;
}

/**
 * A TOML editor: a transparent textarea over a coloured, line-numbered mirror.
 *
 * No new dependency, and no editor framework. The textarea IS the editor — it
 * keeps native undo, selection, IME, spellcheck-off and accessibility — while
 * a div behind it paints the same text with colour. The two stay aligned
 * because they share font, size, line-height, padding and wrapping, and the
 * mirror scrolls with the textarea.
 */
export function TomlEditor({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(() => value.split("\n").length);

  const lines = useMemo(() => value.split("\n"), [value]);
  if (lines.length !== lineCount) setLineCount(lines.length);

  const handleScroll = (event: { currentTarget: HTMLTextAreaElement }) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = scrollTop;
      mirrorRef.current.scrollLeft = scrollLeft;
    }
    // The gutter scrolls vertically only — it has no horizontal extent to lose.
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab indents instead of leaving the field. Escape restores the browser
    // behaviour, so the editor is never a keyboard trap.
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    const el = event.currentTarget;
    const { selectionStart, selectionEnd } = el;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = selectionStart + 2;
    });
  };

  // One shared type ramp for all three layers; any drift here shows up as the
  // colour sliding off the characters.
  const typeface = "font-mono text-[11px] leading-[1.6]";

  return (
    <div
      className={cn(
        "relative flex min-h-0 overflow-hidden rounded-lg border border-border bg-background focus-within:border-foreground/30",
        className,
      )}
    >
      <div
        ref={gutterRef}
        aria-hidden
        className={cn(
          "shrink-0 select-none overflow-hidden border-r border-border/50 bg-foreground/[0.02] py-3 pl-3 pr-2 text-right text-muted-foreground/40",
          typeface,
        )}
      >
        {lines.map((_, i) => (
          // Index IS the identity of a line number — there is nothing else it
          // could be keyed by, and the list is append/remove-at-end in practice.
          // eslint-disable-next-line react/no-array-index-key
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div
          ref={mirrorRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-3",
            typeface,
          )}
        >
          {lines.map((line, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i}>
              {line.length === 0 ? (
                " "
              ) : (
                <>
                  {tokenizeTomlLine(line).map((token, j) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <span className={TOKEN_CLASS[token.kind]} key={j}>
                      {token.text}
                    </span>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
        <textarea
          aria-label={ariaLabel}
          value={value}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          className={cn(
            // Transparent text over the mirror; the caret and selection stay
            // visible because only `color` is cleared.
            "absolute inset-0 size-full resize-none whitespace-pre-wrap break-words bg-transparent p-3 text-transparent caret-foreground outline-none",
            typeface,
          )}
        />
      </div>
    </div>
  );
}
