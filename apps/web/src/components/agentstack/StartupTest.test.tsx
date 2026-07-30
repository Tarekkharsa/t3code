import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { StartupTest } from "./AgentstackControl";

const noop = () => {};
const confirm = async () => {};
const render = (state: Parameters<typeof StartupTest>[0]["state"]) =>
  renderToStaticMarkup(
    <StartupTest
      state={state}
      onRequest={noop}
      onConfirm={confirm}
      onCancel={noop}
      onReviewTrust={noop}
    />,
  );

describe("StartupTest", () => {
  it("says what it will do before starting anything", () => {
    const markup = render({ phase: "confirm" });
    expect(markup).toContain("starts every stdio server");
    expect(markup).toContain("Nothing is written");
  });

  it("sends a refused probe to the trust review instead of a retry", () => {
    const markup = render({
      phase: "done",
      probe: { ran: false, skipped_reason: "drifted", servers: [] },
      unavailable: false,
    });
    expect(markup).toContain("Review this project");
    expect(markup).not.toContain("Test server startup");
  });

  it("renders per-server results", () => {
    const markup = render({
      phase: "done",
      probe: {
        ran: true,
        skipped_reason: null,
        servers: [{ server: "figma", status: "ok", tools: 3, elapsed_ms: 120 }],
      },
      unavailable: false,
    });
    expect(markup).toContain("figma");
    expect(markup).toContain("3 tools");
  });
});
