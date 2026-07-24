import React, { Suspense, use, useEffect, type ReactNode } from "react";

import { fnv1a32 } from "~/lib/diffRendering";
import { LRUCache } from "~/lib/lruCache";

/**
 * Renders a deterministic Mermaid flowchart (from `blueprintToMermaid`) to SVG.
 *
 * Mermaid is a heavy dependency, so it is lazy-loaded via dynamic import behind
 * a Suspense boundary — the exact pattern the shiki code path in ChatMarkdown
 * uses. It is initialized with `securityLevel: "strict"` (Mermaid runs its
 * output through DOMPurify and disables click/callback interactions) and
 * `startOnLoad: false` (we render explicitly, never by scanning the DOM).
 *
 * The Mermaid SOURCE is already-escaped, trusted structure produced by our pure
 * renderer; even so, strict mode is a second line of defence on the generated
 * SVG. A render failure falls back to the raw Mermaid text in a plain <pre> —
 * it never throws past the error boundary.
 */

// mermaid v11's config type is broad; we only ever pass this fixed, safe shape.
interface MermaidLike {
  initialize: (config: {
    startOnLoad: boolean;
    securityLevel: "strict";
    theme: "default" | "dark";
    // fontFamily keeps the graph consistent with the app; optional.
    fontFamily?: string;
  }) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidLike> | null = null;

function getMermaid(): Promise<MermaidLike> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid")
    .then((mod) => mod.default as unknown as MermaidLike)
    .catch((error: unknown) => {
      // Allow a later retry if the chunk failed to load.
      mermaidPromise = null;
      throw error;
    });
  return mermaidPromise;
}

// Content-keyed cache of rendered SVG, so re-rendering the same blueprint (e.g.
// on scroll remount) does not re-run Mermaid.
const MAX_SVG_CACHE_ENTRIES = 100;
const MAX_SVG_CACHE_MEMORY_BYTES = 8 * 1024 * 1024;
const svgCache = new LRUCache<string>(MAX_SVG_CACHE_ENTRIES, MAX_SVG_CACHE_MEMORY_BYTES);

// In-flight render promises keyed identically, so concurrent mounts share work
// and Suspense can `use()` a stable promise.
const renderPromiseCache = new Map<string, Promise<string>>();

// Monotonic id source: Mermaid needs a unique DOM id per render call.
let renderSeq = 0;

function cacheKey(mermaidText: string, theme: "light" | "dark"): string {
  return `${fnv1a32(mermaidText).toString(36)}:${mermaidText.length}:${theme}`;
}

function renderMermaidToSvg(
  key: string,
  mermaidText: string,
  theme: "light" | "dark",
): Promise<string> {
  const existing = renderPromiseCache.get(key);
  if (existing) return existing;

  const promise = getMermaid()
    .then(async (mermaid) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "default",
      });
      renderSeq += 1;
      const { svg } = await mermaid.render(`agentstack-blueprint-${renderSeq}`, mermaidText);
      svgCache.set(key, svg, svg.length * 2);
      return svg;
    })
    .catch((error: unknown) => {
      // Drop the failed promise so a remount can retry; rethrow so the Suspense
      // boundary surfaces it to the error boundary (which shows the raw text).
      renderPromiseCache.delete(key);
      throw error;
    });

  renderPromiseCache.set(key, promise);
  return promise;
}

class BlueprintGraphErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function RawMermaidFallback({ mermaidText }: { mermaidText: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border/50 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
      {mermaidText}
    </pre>
  );
}

function RenderedBlueprintGraph({
  mermaidText,
  theme,
}: {
  mermaidText: string;
  theme: "light" | "dark";
}) {
  const key = cacheKey(mermaidText, theme);
  const svg = use(renderMermaidToSvg(key, mermaidText, theme));

  useEffect(() => {
    svgCache.set(key, svg, svg.length * 2);
  }, [key, svg]);

  return (
    <div
      className="agentstack-blueprint-graph flex w-full justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid produced this SVG under securityLevel: "strict" (DOMPurify-sanitized).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function BlueprintGraph({
  mermaidText,
  theme,
}: {
  mermaidText: string;
  theme: "light" | "dark";
}) {
  const key = cacheKey(mermaidText, theme);
  const cachedSvg = svgCache.get(key);
  const fallback = <RawMermaidFallback mermaidText={mermaidText} />;

  if (cachedSvg != null) {
    return (
      <div
        className="agentstack-blueprint-graph flex w-full justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: cachedSvg }}
      />
    );
  }

  return (
    <BlueprintGraphErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <RenderedBlueprintGraph mermaidText={mermaidText} theme={theme} />
      </Suspense>
    </BlueprintGraphErrorBoundary>
  );
}
