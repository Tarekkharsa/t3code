/**
 * What the popover's one region actually DRAWS.
 *
 * The whole point of the first page is subtraction: one problem or one
 * toolset, one verb, nothing else. That is a claim about rendered output — a
 * regression here looks like a passing logic test and a crowded panel — so it
 * is asserted on rendered output.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  AgentstackActiveSession,
  AgentstackToolset,
  AgentstackToolsetsResult,
} from "@t3tools/contracts";

import { ConcernCard, WorkingUnder } from "./AgentstackControl";
import { selectAgentstackPrimaryConcern } from "./agentstack-logic";

const noop = () => {};
const never = async () => ({ ok: true, message: "" });

/** The shape of one `toolsets` read, with only the fields these tests vary. */
function toolsets(
  profiles: ReadonlyArray<AgentstackToolset>,
  session: AgentstackActiveSession | null,
): AgentstackToolsetsResult {
  return {
    installed: true,
    checkedAt: 0,
    toolsets: { path: "/repo", trust: "trusted", profiles, session },
  };
}

/** A declared toolset; `blockers` empty and `pinned` true unless overridden. */
function profile(fields: Partial<AgentstackToolset> & { name: string }): AgentstackToolset {
  return { servers: [], skills: [], pinned: true, blockers: [], ...fields };
}

describe("the first page — needs you", () => {
  it("states the consequence, offers one button, and never prints the command", () => {
    const concern = selectAgentstackPrimaryConcern({
      rows: [
        {
          key: "guard",
          label: "Guard",
          summary: "guard not enabled",
          level: "warn",
          action: "guard-install",
        },
        { key: "library", label: "Library", summary: "1 skill not installed", level: "warn" },
      ],
      findings: [],
      trust: "trusted",
    });
    if (!concern) throw new Error("expected a concern");
    const markup = renderToStaticMarkup(<ConcernCard concern={concern} onAct={noop} />);

    expect(markup).toContain("Agent commands run without a pre-check");
    expect(markup).toContain("Enable guard");
    expect(markup).toContain("reversible · only adds protection");
    // The shell command belongs at the confirm step, not on the glance
    // surface — it is not something you can run from here.
    expect(markup).not.toContain("agentstack guard install");
    // One problem. The second row is a count in the footer, not a second card.
    expect(markup).not.toContain("1 skill not installed");
    expect(concern.others).toBe(1);
  });
});

describe("the first page — ready", () => {
  it("names the toolset it is working under and offers the one verb that changes it", () => {
    const markup = renderToStaticMarkup(
      <WorkingUnder
        toolsets={toolsets(
          [
            profile({
              name: "backend",
              servers: ["github", "postgres"],
              skills: ["deploy-checklist"],
              active: true,
            }),
            profile({ name: "design", servers: ["figma"] }),
          ],
          null,
        )}
        canSessions
        onSwitch={noop}
        onEnd={never}
      />,
    );

    expect(markup).toContain("WORKING UNDER");
    expect(markup).toContain("backend");
    expect(markup).toContain("2 servers · 1 skill");
    expect(markup).toContain("Switch");
    // The other declared toolset is behind Switch, not listed here.
    expect(markup).not.toContain("design");
  });

  it("offers Stop using only while a temporary session is actually open", () => {
    const profiles = [profile({ name: "backend" })];
    const idle = renderToStaticMarkup(
      <WorkingUnder
        toolsets={toolsets(profiles, null)}
        canSessions
        onSwitch={noop}
        onEnd={never}
      />,
    );
    // Nothing is active and no session is open: the panel says so rather than
    // naming a toolset the project is not in fact working under.
    expect(idle).not.toContain("WORKING UNDER");
    expect(idle).toContain("No toolset is active");

    const live = renderToStaticMarkup(
      <WorkingUnder
        toolsets={toolsets(profiles, {
          profile: "backend",
          scope: "project",
          started_unix: Math.floor(Date.now() / 1000) - 720,
        })}
        canSessions
        onSwitch={noop}
        onEnd={never}
      />,
    );
    expect(live).toContain("WORKING UNDER");
    expect(live).toContain("Stop using");
    expect(live).toContain("in use 12m");
  });
});
