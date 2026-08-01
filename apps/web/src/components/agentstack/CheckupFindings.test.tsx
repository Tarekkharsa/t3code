/**
 * What the Checkup row actually DRAWS for a real doctor payload.
 *
 * The row counted findings and showed none of them, so the claims worth
 * asserting on rendered output are the ones the count implied: every finding is
 * on screen with the fix doctor named, and a one-click fix appears only where
 * the panel may honestly offer one. The logic tests next door cover the
 * ordering and the gates; this covers the picture.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CheckupFindings } from "./AgentstackControl";
import { deriveAgentstackFindings, type AgentstackDoctorReport } from "./agentstack-logic";

/** One error, several warnings — the shape the awkward "1 error(s)" came from. */
const report: AgentstackDoctorReport = {
  errors: 1,
  warnings: 4,
  sections: [
    {
      title: "Secrets",
      lines: [
        { level: "warn", msg: "GITHUB_TOKEN not found ↳ agentstack secret set GITHUB_TOKEN" },
      ],
    },
    {
      title: "Drift",
      lines: [
        { level: "warn", msg: "Codex CLI 2 change(s) pending ↳ agentstack apply --write" },
        { level: "warn", msg: "Claude Code 1 change(s) pending ↳ agentstack apply --write" },
      ],
    },
    {
      title: "t3code (supervisor)",
      lines: [
        {
          level: "error",
          msg: "guard hooks do not cover the detected providers ↳ agentstack guard install",
        },
      ],
    },
    { title: "Skills", lines: [{ level: "warn", msg: "code-review not installed" }] },
  ],
};

const findings = deriveAgentstackFindings(report);

const draw = (features: ReadonlyArray<string> | undefined) =>
  renderToStaticMarkup(
    <CheckupFindings findings={findings} features={features} onRequestAction={() => {}} />,
  );

describe("CheckupFindings", () => {
  it("shows the findings and their fixes instead of a count alone", () => {
    const markup = draw(["status-v1"]);

    // The error leads, whatever section order doctor used.
    expect(markup.indexOf("guard hooks do not cover")).toBeLessThan(
      markup.indexOf("GITHUB_TOKEN not found"),
    );
    expect(markup).toContain("guard hooks do not cover the detected providers");
    // The fix stays on screen even where a button also runs it.
    expect(markup).toContain("guard");
    expect(markup).toContain("install");
  });

  it("shows the whole list flat — no header, no count, no second gate", () => {
    // The list IS the content: no disclosure header, and no count of its own
    // (the summary line above the list owns every number). The cap is for a
    // pathological report; an ordinary one shows everything at once.
    const markup = draw(["status-v1"]);
    expect(markup).not.toContain("What the checkup found");
    expect(markup).not.toContain("findings");
    expect(markup).toContain("code-review not installed");
    expect(markup).not.toContain("See all");
  });

  it("offers the fixed action only when the CLI advertised the contract", () => {
    expect(draw(["status-v1"])).toContain("Enable guard");

    // Older CLI (no advertised features): the command is still there to copy,
    // but nothing offers to run it.
    const legacy = draw(undefined);
    expect(legacy).toContain("guard hooks do not cover the detected providers");
    expect(legacy).not.toContain("Enable guard");
  });

  it("never offers to re-render drift from here, however advertised", () => {
    // The Manifest row routes this exact fact to the drift review, because
    // adopt vs apply differ and the scope must be chosen. A "Re-render" button
    // on the same fact a few rows below is the panel contradicting itself —
    // and the one-click side would win.
    const markup = draw(["status-v1"]);
    expect(markup).toContain("change(s) pending");
    expect(markup).toContain("agentstack");
    expect(markup).not.toContain("Re-render");
  });

  it("renders nothing at all when the checkup is clean", () => {
    const markup = renderToStaticMarkup(
      <CheckupFindings findings={[]} features={["status-v1"]} onRequestAction={() => {}} />,
    );
    expect(markup).toBe("");
  });
});

describe("CheckupFindings — acting on what it found", () => {
  const findings = deriveAgentstackFindings(report);
  const noop = () => {};

  it("gives a drift finding the review that is the honest way to act on it", () => {
    // Drift never becomes a one-click fix (adopt and apply differ, and the
    // scope has to be chosen) — but refusing the button left these rows
    // printing a command with nothing to press, which is homework, not a
    // checkup. The review dialog is what they open.
    const markup = renderToStaticMarkup(
      <CheckupFindings
        findings={findings}
        features={["status-v1"]}
        onRequestAction={noop}
        onReviewDrift={noop}
      />,
    );
    expect(markup).toContain("Codex CLI 2 change(s) pending");
    expect(markup).toContain("Review");
    // Still never the destructive verb on a drift row.
    expect(markup).not.toContain("Re-render");
  });

  it("offers no review when the caller has no drift surface to open", () => {
    const markup = renderToStaticMarkup(
      <CheckupFindings findings={findings} features={["status-v1"]} onRequestAction={noop} />,
    );
    expect(markup).toContain("Codex CLI 2 change(s) pending");
    expect(markup).not.toContain(">Review<");
  });

  it("drops a button a sibling on the same screen already offers", () => {
    // The Setup tab shows the recommended next action at the top AND this
    // list below it. Two "Enable guard" buttons on one screen read as two
    // repairs; there is one machine-wide write.
    const both = renderToStaticMarkup(
      <CheckupFindings findings={findings} features={["status-v1"]} onRequestAction={noop} />,
    );
    expect(both).toContain("Enable guard");

    const deduped = renderToStaticMarkup(
      <CheckupFindings
        findings={findings}
        features={["status-v1"]}
        onRequestAction={noop}
        alreadyOffered="guard-install"
      />,
    );
    expect(deduped).not.toContain("Enable guard");
    // The finding and its command stay — only the duplicate button goes. The
    // command renders as one copyable line, so it is asserted whole.
    expect(deduped).toContain("guard hooks do not cover the detected providers");
    expect(deduped).toContain("agentstack guard install");
  });

  it("sends a trust finding to the review, on any binary", () => {
    // `agentstack trust` can never be a governed action — consent is bound to
    // the exact bytes, which only the review screen shows — so this finding used
    // to print a terminal command and nothing else. The feature that gates
    // running a scraped fix has no say here: the review runs nothing.
    const trustFindings = deriveAgentstackFindings({
      errors: 1,
      warnings: 0,
      sections: [
        {
          title: "Trust",
          lines: [
            {
              level: "error",
              msg: "this project is not trusted at its current bytes ↳ agentstack trust",
            },
          ],
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <CheckupFindings
        findings={trustFindings}
        features={undefined}
        onRequestAction={noop}
        onReviewTrust={noop}
      />,
    );
    expect(markup).toContain("not trusted at its current bytes");
    expect(markup).toContain("Review &amp; use");

    // No review surface to open → the command alone, as before.
    const noSurface = renderToStaticMarkup(
      <CheckupFindings findings={trustFindings} features={["status-v1"]} onRequestAction={noop} />,
    );
    expect(noSurface).toContain("not trusted at its current bytes");
    expect(noSurface).not.toContain("Review");
  });
});
