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

  it("opens onto the whole list, not onto three of five and a second gate", () => {
    // One gate. The disclosure is the gate; the cap is for a pathological
    // report, and an ordinary one must not need a second click.
    const markup = draw(["status-v1"]);
    expect(markup).toContain("5 findings");
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
