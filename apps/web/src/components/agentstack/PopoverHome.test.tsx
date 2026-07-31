/**
 * What the popover's footer, inline switch, and mode chooser actually DRAW.
 *
 * The wireframe's claims are claims about rendered output — "the footer says
 * the mode as one clickable word", "a coverage number that shrinks is shown,
 * not hidden", "no confirm renders on a blocked plan" — so they are asserted
 * on markup, the same way FirstPage.test.tsx pins the one-region rule.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AgentstackProfileEditPreview, AgentstackToolsetsResult } from "@t3tools/contracts";

import { agentstackModeWord } from "./agentstack-logic";
import { InlineToolsetSwitch, ModePlan, PopoverFooter } from "./PopoverHome";

const noop = () => {};
const never = async () => ({ ok: true, message: "" });

describe("the footer", () => {
  it("says ready, the mode as a clickable word, and the honest CLI count", () => {
    const markup = renderToStaticMarkup(
      <PopoverFooter
        concern={false}
        modeLabel="static"
        onMode={noop}
        clis={{ capable: 13, detected: 13 }}
        servedLive={false}
        onCoverage={noop}
        onManage={noop}
      />,
    );
    expect(markup).toContain("Ready");
    expect(markup).toContain("on disk");
    expect(markup).toContain("13 CLIs");
    expect(markup).toContain("Manage");
    // The mode is a word, not a card: one button, no WORKING UNDER-style frame.
    expect(markup).not.toContain("DELIVERY");
  });

  it("scopes the count in live delivery — a shrinking number is named, not hidden", () => {
    const markup = renderToStaticMarkup(
      <PopoverFooter
        concern={false}
        modeLabel="zero-files"
        onMode={noop}
        clis={{ capable: 11, detected: 13 }}
        servedLive={true}
        onCoverage={noop}
        onManage={noop}
      />,
    );
    expect(markup).toContain("served live");
    expect(markup).toContain("11 of 13 CLIs");
  });

  it("swaps to needs-review on a concern and drops the count — one problem is the rule", () => {
    const markup = renderToStaticMarkup(
      <PopoverFooter
        concern={true}
        modeLabel="static"
        onMode={noop}
        clis={{ capable: 13, detected: 13 }}
        servedLive={false}
        onCoverage={noop}
        onManage={noop}
      />,
    );
    expect(markup).toContain("Needs review");
    expect(markup).not.toContain("13 CLIs");
  });

  it("renders the mode as plain text when the CLI cannot switch it", () => {
    const markup = renderToStaticMarkup(
      <PopoverFooter
        concern={false}
        modeLabel="static"
        onMode={null}
        clis={null}
        servedLive={false}
        onCoverage={noop}
        onManage={noop}
      />,
    );
    expect(markup).toContain("on disk");
    // Exactly one button (Manage): no clickable mode word without set-mode-v1.
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("says nothing about the mode on a CLI that does not report one", () => {
    const markup = renderToStaticMarkup(
      <PopoverFooter
        concern={false}
        modeLabel={null}
        onMode={null}
        clis={null}
        servedLive={false}
        onCoverage={noop}
        onManage={noop}
      />,
    );
    expect(markup).toContain("Ready");
    expect(markup).not.toContain("on disk");
  });
});

describe("the mode plan", () => {
  const preview = (over: Partial<AgentstackProfileEditPreview>): AgentstackProfileEditPreview => ({
    action: "set-mode",
    consent_digest: `sha256:${"a".repeat(64)}`,
    mode: "zero-files",
    current_mode: "static",
    changed: true,
    removes: [{ label: "Claude Code · servers (this project)", path: ".mcp.json" }],
    removes_gitignore_block: true,
    removes_instructions: true,
    renders: null,
    locks: false,
    bridge: { registers: true, detected: 13, capable: 11, incapable: ["Codex CLI", "Gemini CLI"] },
    requires_trust: false,
    machine_scope: true,
    undo: "agentstack restore --last",
    ...over,
  });
  const plan = (over: Partial<AgentstackProfileEditPreview>) =>
    renderToStaticMarkup(
      <ModePlan
        option={{ mode: "zero-files", title: "Served live" }}
        plan={{ phase: "plan", digest: `sha256:${"a".repeat(64)}`, preview: preview(over) }}
        onConfirm={noop}
        onCancel={noop}
        onReviewTrust={noop}
      />,
    );

  it("draws the real transition — removals, coverage, who falls out, scope, undo, confirm", () => {
    const markup = plan({});
    expect(markup).toContain("Claude Code · servers (this project)");
    expect(markup).toContain("remove the managed .gitignore block");
    expect(markup).toContain("11 of 13 CLIs");
    // The two CLIs that stop being served are NAMED, not summarized away.
    expect(markup).toContain("Codex CLI, Gemini CLI");
    expect(markup).toContain("instructions are not delivered live");
    expect(markup).toContain("Machine-wide.");
    expect(markup).toContain("does not unregister it");
    expect(markup).toContain("agentstack restore --last");
    // The third click exists: an explicit confirm, plus its cancel.
    expect(markup).toContain("Switch to served live");
    expect(markup).toContain("Cancel");
  });

  it("replaces the confirm with the trust review when the CLI would refuse", () => {
    const markup = plan({ requires_trust: true });
    expect(markup).toContain("Review this project first");
    expect(markup).not.toContain("Switch to served live");
  });

  it("shows the CLI's own blocker instead of a confirm that cannot succeed", () => {
    const markup = plan({
      mode_blocker: "this trusted project is served live by the machine-wide bridge",
    });
    expect(markup).toContain("served live by the machine-wide bridge");
    expect(markup).not.toContain("Switch to served live");
  });

  it("blocks every direction while a session holds the project's files", () => {
    const markup = plan({ session_active: "rust-dev" });
    expect(markup).toContain("rust-dev");
    expect(markup).toContain("stop using it first");
    expect(markup).not.toContain("Switch to served live");
  });
});

describe("the inline toolset switch", () => {
  const toolsets = (trust: string): AgentstackToolsetsResult => ({
    installed: true,
    checkedAt: 0,
    toolsets: {
      path: "/repo",
      trust,
      session: null,
      profiles: [
        { name: "rust-dev", servers: ["github"], skills: ["review"], pinned: true, blockers: [] },
        { name: "writing", servers: [], skills: ["prose"], pinned: true, blockers: [] },
      ],
    },
  });

  it("lists every toolset with the current one tagged, plus the door to creation", () => {
    const markup = renderToStaticMarkup(
      <InlineToolsetSwitch
        toolsets={toolsets("trusted")}
        canSessions={true}
        onStart={never}
        onEnd={never}
        onReviewTrust={noop}
        onManage={noop}
        onDone={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("rust-dev");
    expect(markup).toContain("writing");
    expect(markup).toContain("+ New toolset…");
    expect(markup).toContain("SWITCH TO");
  });

  it("routes a trust-blocked project to the review instead of a dead pick", () => {
    const markup = renderToStaticMarkup(
      <InlineToolsetSwitch
        toolsets={toolsets("untrusted")}
        canSessions={true}
        onStart={never}
        onEnd={never}
        onReviewTrust={noop}
        onManage={noop}
        onDone={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("review this project first");
    expect(markup).toContain("Review this project");
  });
});

describe("the footer's mode vocabulary", () => {
  it("maps every mode to its word and never renders an unknown one blank", () => {
    expect(agentstackModeWord("static")).toBe("on disk");
    expect(agentstackModeWord("zero-files")).toBe("served live");
    expect(agentstackModeWord("clean-at-rest")).toBe("only while you work");
    expect(agentstackModeWord("future-mode")).toBe("future-mode");
    expect(agentstackModeWord(null)).toBeNull();
  });
});
