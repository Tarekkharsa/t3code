/**
 * What the panel CLAIMS a finished toolset edit did.
 *
 * `create-profile` stopped rendering (AgentStack review finding H3): it writes
 * the manifest entry and re-locks, and no native config moves. The panel's job
 * is to stop promising the opposite — but only against a CLI that actually
 * behaves that way, since a binary advertising only `profiles-edit-v1` still
 * re-renders on create and would be double-activated by an Activate button.
 * Both halves are claims about rendered output, so both are asserted on it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EditFlowCard } from "./AgentstackControl";

const CREATE = { kind: "create-profile", name: "web", skills: ["pdf"], servers: [] } as const;

/** The CLI's own last line after a create on a `toolset-create-v2` binary. */
const CLI_LINE = "Undo: delete the [profiles.web] block from agentstack.toml";

const noop = () => {};
const activate = async () => ({ ok: true, message: "started" });

describe("EditFlowCard — create-profile outcome", () => {
  it("says nothing was rendered and offers the activation step on a toolset-create-v2 CLI", () => {
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "done",
          ok: true,
          message: CLI_LINE,
          title: 'New toolset "web" with 1 skill',
          edit: CREATE,
        }}
        createNeedsActivation
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("created");
    // The load-bearing sentence: the toolset exists, but nothing is in use.
    expect(markup).toContain("Nothing was rendered");
    // The activation step, in the same words the Toolsets list uses.
    expect(markup).toContain("Use temporarily");
    // The CLI's own line still shows — two surfaces, one truth.
    expect(markup).toContain("agentstack.toml");
  });

  it("names the command instead of a button when the CLI has no session control", () => {
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "done",
          ok: true,
          message: CLI_LINE,
          title: 'New toolset "web" with 1 skill',
          edit: CREATE,
        }}
        createNeedsActivation
        onActivate={null}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("Nothing was rendered");
    expect(markup).not.toContain("Use temporarily");
    expect(markup).toContain("agentstack");
    expect(markup).toContain("session");
    expect(markup).toContain("start");
  });

  it("keeps the plain success line on an older CLI, which still renders on create", () => {
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "done",
          ok: true,
          message: "toolset web created.",
          title: 'New toolset "web" with 1 skill',
          edit: CREATE,
        }}
        createNeedsActivation={false}
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("Done");
    expect(markup).toContain("toolset web created.");
    // No second activation offered for something the older binary already
    // rendered into every native config.
    expect(markup).not.toContain("Use temporarily");
    expect(markup).not.toContain("Nothing was rendered");
  });

  it("drops the render/${REF} clauses from the create confirmation, and keeps them for an add", () => {
    const creating = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "confirm",
          edit: CREATE,
          title: 'New toolset "web" with 1 skill',
          digest: "sha256:abc",
          note: null,
          removal: null,
        }}
        createNeedsActivation
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );
    expect(creating).toContain("Nothing is rendered");
    expect(creating).not.toContain("blocks the render");

    const adding = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "confirm",
          edit: { kind: "add-skill-to-profile", profile: "web", name: "pdf" },
          title: 'Add skill "pdf" to toolset "web"',
          digest: "sha256:abc",
          note: null,
          removal: null,
        }}
        createNeedsActivation
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );
    expect(adding).toContain("re-renders the toolset");
    expect(adding).toContain("blocks the render");
  });
});
