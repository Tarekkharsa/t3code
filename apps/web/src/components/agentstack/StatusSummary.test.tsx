/**
 * What the panel actually DRAWS for a given doctor payload.
 *
 * The advisory tier only pays off if both halves hold: a healthy setup must
 * read Ready (not the permanent orange it used to), and the advisories the CLI
 * counted must still be visible rather than silently dropped. Both are claims
 * about rendered output, so they are asserted on rendered output — the logic
 * tests next door cover the mapping, not the picture.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { StatusSummary } from "./AgentstackControl";
import { deriveAgentstackStatusChip } from "./agentstack-logic";

/** The chip the panel would build for a given CLI `state`. */
function chipFor(state: string) {
  const chip = deriveAgentstackStatusChip({ state });
  if (!chip) throw new Error(`no chip for state ${state}`);
  return chip;
}

describe("StatusSummary", () => {
  it("reads Ready and still shows the note count for a healthy setup carrying advisories", () => {
    // The exact payload the CLI emits after a clean init+apply on a machine
    // with Codex installed but never used: nothing to fix, two notes.
    const markup = renderToStaticMarkup(
      <StatusSummary chip={chipFor("ready")} nextAction={null} advisories={2} />,
    );

    expect(markup).toContain("Ready");
    expect(markup).not.toContain("Needs attention");
    // Visible, pluralised, and attached to the chip line.
    expect(markup).toContain("2 notes");
    // Muted, never a fault colour — styling these as a problem would
    // re-introduce the permanent-orange behaviour the advisory tier removed.
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("bg-warning");
    expect(markup).not.toContain("bg-destructive");
    // Nothing pending means no "Next" row at all, not an empty one.
    expect(markup).not.toContain("Next");
  });

  it("says 'note' for one and renders nothing for zero", () => {
    const one = renderToStaticMarkup(
      <StatusSummary chip={chipFor("ready")} nextAction={null} advisories={1} />,
    );
    expect(one).toContain("1 note");
    expect(one).not.toContain("1 notes");

    const none = renderToStaticMarkup(
      <StatusSummary chip={chipFor("ready")} nextAction={null} advisories={0} />,
    );
    expect(none).toContain("Ready");
    expect(none).not.toContain("note");
  });

  it("drops the count entirely when the CLI does not advertise the contract", () => {
    // The caller passes null when `doctor-advisories-v1` is absent from the
    // negotiated features. An older binary must render exactly as before.
    const markup = renderToStaticMarkup(
      <StatusSummary chip={chipFor("ready")} nextAction={null} advisories={null} />,
    );
    expect(markup).toContain("Ready");
    expect(markup).not.toContain("note");
  });

  it("still leads with the problem, and the fix, when something needs attention", () => {
    const markup = renderToStaticMarkup(
      <StatusSummary
        chip={chipFor("needs_attention")}
        nextAction="agentstack apply --write"
        advisories={1}
      />,
    );
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("bg-warning");
    expect(markup).toContain("agentstack apply --write");
    // An advisory alongside a real warning is still shown, still muted — it
    // must not compete with the recommended action.
    expect(markup).toContain("1 note");
  });

  it("owns the checkup counts — the one place on the tab that counts anything", () => {
    // The tab used to count in four vocabularies (notes by the chip, warnings
    // on the Checkup row, findings on the list header and per group) for one
    // report. The summary line now carries error/warning counts itself, so
    // the list below can just list.
    const markup = renderToStaticMarkup(
      <StatusSummary
        chip={chipFor("needs_attention")}
        errors={1}
        warnings={2}
        nextAction={null}
        advisories={1}
      />,
    );
    expect(markup).toContain("1 error");
    expect(markup).toContain("2 warnings");
    expect(markup).toContain("1 note");

    // A clean report renders no zero-counts.
    const clean = renderToStaticMarkup(
      <StatusSummary
        chip={chipFor("ready")}
        errors={0}
        warnings={0}
        nextAction={null}
        advisories={null}
      />,
    );
    expect(clean).not.toContain("0 error");
    expect(clean).not.toContain("warning");
  });

  it("offers the review when the recommendation is to trust this project", () => {
    // The trust recommendation is a screen, not a write: it must never reach the
    // action RPC, and it must not be the one recommendation you cannot act on.
    const markup = renderToStaticMarkup(
      <StatusSummary
        chip={chipFor("needs_attention")}
        nextAction="agentstack trust ."
        advisories={null}
        onRunNextAction={() => {
          throw new Error("the trust review must never go through the action RPC");
        }}
        onReviewTrust={() => {}}
      />,
    );
    // With the review on offer, the row says what the step IS rather than the
    // command that performs it: the button is the actionable form, and printing
    // argv beside it is the same instruction twice.
    expect(markup).toContain("Review what this project declares");
    expect(markup).toContain("Review &amp; trust");
    expect(markup).not.toContain("agentstack trust .");

    // No review surface → the command still reads as a command to run, and
    // nothing offers to fire it.
    const noSurface = renderToStaticMarkup(
      <StatusSummary
        chip={chipFor("needs_attention")}
        nextAction="agentstack trust ."
        advisories={null}
        onRunNextAction={() => {}}
      />,
    );
    expect(noSurface).toContain("agentstack trust .");
    expect(noSurface).not.toContain("Review");
  });
});
