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

import { EditFlowCard, LibraryDriftNote } from "./AgentstackControl";

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

describe("EditFlowCard — preview refusals", () => {
  const REFUSAL =
    "won't delete 'spare' — it is the only toolset here, and with none declared " +
    "every server in the manifest becomes reachable instead of just this set.";

  it("shows the CLI's refusal verbatim and never tells the user to update", () => {
    // The E2E-observed defect: the CLI's correct refusal (deleting the only
    // toolset widens access) was re-captioned "update agentstack" — wrong in
    // both halves, since updating won't help and a terminal refuses the same.
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{ phase: "refused", title: 'Delete toolset "spare"', message: REFUSAL }}
        createNeedsActivation
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("only toolset here");
    expect(markup).toContain("Nothing was changed.");
    expect(markup).not.toContain("Update agentstack");
    expect(markup).not.toContain("no digest");
  });

  it("surfaces an apply-time refusal verbatim instead of a bare failure", () => {
    // The CLI can accept the preview (a digest is issued) and still refuse the
    // apply — e.g. a live session fences a rename/delete. That refusal comes
    // back as ok:false with the CLI's own sentence, and the panel must show
    // THAT sentence (the actionable next step), not swallow it behind a generic
    // "couldn't apply".
    const APPLY_REFUSAL =
      "won't rename 'web' while a session is using it — end the session first, then rename.";
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "done",
          ok: false,
          message: APPLY_REFUSAL,
          title: 'Rename toolset "web"',
          edit: { kind: "rename-profile", name: "web", to: "backend" },
        }}
        createNeedsActivation={false}
        onActivate={null}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("Couldn&#x27;t apply");
    expect(markup).toContain("end the session first");
    expect(markup).not.toContain("The change could not be applied.");
  });

  it("says couldn't-check for a preview that never answered, not old-CLI", () => {
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{ phase: "unavailable", title: 'Delete toolset "spare"' }}
        createNeedsActivation
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("didn&#x27;t answer");
    expect(markup).not.toContain("Update agentstack");
  });

  it("keeps the update guidance only for the digest-less legacy preview", () => {
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{ phase: "unsupported", title: 'Delete toolset "spare"' }}
        createNeedsActivation
        onActivate={activate}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("no digest");
    expect(markup).toContain("Update agentstack");
  });
});

describe("EditFlowCard — project capability removal", () => {
  it("distinguishes deleting a project server from deleting the library copy", () => {
    const markup = renderToStaticMarkup(
      <EditFlowCard
        flow={{
          phase: "confirm",
          edit: { kind: "remove-capability", group: "server", name: "computer-use" },
          title: 'Remove server "computer-use" from this project',
          digest: "sha256:abc",
          note: null,
          removal: {
            kind: "server",
            name: "computer-use",
            scope: "project",
            defined_inline_here: true,
            profiles: [],
          },
        }}
        createNeedsActivation={false}
        onActivate={null}
        onConfirm={noop}
        onBack={noop}
      />,
    );

    expect(markup).toContain("project&#x27;s manifest");
    expect(markup).toContain("machine-wide library is untouched");
    expect(markup).toContain("re-locks and re-renders");
    expect(markup).not.toContain("library trash");
  });
});

describe("LibraryDriftNote — the not-reviewed banner", () => {
  it("tells a needs-review user their edits still register and only using waits", () => {
    // The bug this copy fixes: "added servers stay inert" read as "editing is
    // off", so a "Needs review" user concluded they could not add tools at all
    // and left. Editing/creating a toolset works and saves now; what waits for
    // review is USING one. The banner must say so and must not imply otherwise.
    const markup = renderToStaticMarkup(<LibraryDriftNote onReviewTrust={() => {}} />);

    expect(markup).toContain("you can still edit toolsets");
    expect(markup).toContain("waits for your review");
    // The old, misleading claim must be gone.
    expect(markup).not.toContain("stay inert");
    // Still an actionable review affordance.
    expect(markup).toContain("Review");
    // Primary copy stays in plain user vocabulary — no mechanism nouns.
    expect(markup).not.toContain("manifest");
    expect(markup).not.toContain("lock");
    expect(markup).not.toContain("digest");
  });
});
