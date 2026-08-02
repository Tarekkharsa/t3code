/**
 * The stacking ladder, asserted where it actually bites.
 *
 * The release-blocking bug this pins: the toast viewport is pinned to the
 * top-right corner just under the header, which is exactly where the header's
 * popovers drop from — the AgentStack panel among them. The toast layer used to
 * render at `z-100`, above the popover layer at `z-[60]`, so a persistent toast
 * (the provider "Update Available" prompt, `timeout: 0`) parked a 360px card on
 * top of the open panel. `document.elementFromPoint` at the panel's own
 * controls returned the toast, the click never reached them, and Base UI
 * dismissed the popover on the resulting `focus-out` — "Review this project"
 * and the delivery-mode preview vanished with no error.
 *
 * The focus/pointer interaction itself needs a real browser: this app has no
 * jsdom or testing-library harness, every component test here renders to static
 * markup. What can be pinned is the fact the interaction turned on — the toast
 * layer sits below the popup layer — read off the class strings the components
 * really render, not off the constants alone. On the pre-fix tree the toast
 * string carries `z-100` and this fails.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  NOTIFICATION_LAYER,
  NOTIFICATION_LAYER_CLASS,
  OVERLAY_LAYER,
  OVERLAY_LAYER_CLASS,
  POPUP_LAYER,
  POPUP_LAYER_CLASS,
} from "./layers";
import { POPOVER_POSITIONER_CLASS } from "./popover";
import { TOAST_VIEWPORT_CLASS } from "./toast";

/** The z-index a Tailwind class list resolves to: `z-55` or `z-[60]`. */
function zIndexOf(classes: string): number {
  const match = /(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(classes);
  if (match === null) {
    throw new Error(`no z-index utility in: ${classes}`);
  }
  return Number(match[1]);
}

describe("floating surface stacking ladder", () => {
  it("puts toasts above overlays and below the popups the user opened", () => {
    expect(OVERLAY_LAYER).toBeLessThan(NOTIFICATION_LAYER);
    expect(NOTIFICATION_LAYER).toBeLessThan(POPUP_LAYER);
  });

  it("keeps each class in step with its rung", () => {
    expect(zIndexOf(OVERLAY_LAYER_CLASS)).toBe(OVERLAY_LAYER);
    expect(zIndexOf(NOTIFICATION_LAYER_CLASS)).toBe(NOTIFICATION_LAYER);
    expect(zIndexOf(POPUP_LAYER_CLASS)).toBe(POPUP_LAYER);
  });

  it("renders the toast viewport below the popover positioner", () => {
    // The load-bearing assertion: these are the strings the two components
    // hand to the DOM, so a hard-coded z-index anywhere in either one is
    // caught here rather than live.
    expect(zIndexOf(TOAST_VIEWPORT_CLASS)).toBeLessThan(zIndexOf(POPOVER_POSITIONER_CLASS));
  });

  it("still renders the toast viewport above dialogs and their backdrops", () => {
    // A toast raised during a modal flow has to stay readable, so the fix must
    // not push the stack under the overlay rung.
    expect(zIndexOf(TOAST_VIEWPORT_CLASS)).toBeGreaterThan(OVERLAY_LAYER);
  });
});
