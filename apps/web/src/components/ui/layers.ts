/**
 * One stacking ladder for the app's floating surfaces.
 *
 * The rungs, lowest first:
 *
 * 1. **Overlay** (`z-50`) — dialogs, sheets, the command palette, tooltips.
 *    Surfaces that own the screen while they are up.
 * 2. **Notification** (`z-55`) — the toast viewport. Above overlays, so a toast
 *    raised during a modal flow is still readable.
 * 3. **Popup** (`z-[60]`) — popovers and menus. Above toasts, because these are
 *    surfaces the user just opened by clicking; whatever is passively floating
 *    must not take the clicks meant for them.
 *
 * Rung 3 exists because of a real defect. The toast viewport is pinned to the
 * top-right just under the header (`--toast-header-offset`), which is exactly
 * where the header's own popovers drop from — the AgentStack panel is anchored
 * `align="end"` under a trigger in that corner. With the toast layer above them
 * at `z-100`, a persistent toast (the provider "Update Available" prompt, which
 * is `timeout: 0`) parked a 360px card over the top of the open panel. Clicks
 * aimed at the panel's own controls landed on the toast instead, Base UI read
 * the resulting focus change as `focus-out` and dismissed the popover — so
 * "Review this project" and the delivery-mode preview silently went away, and
 * came back the moment the toast was dismissed.
 *
 * Keep toasts between the two: below a popup the user is actively working in,
 * above the overlays they float over.
 */

export const OVERLAY_LAYER = 50;
export const NOTIFICATION_LAYER = 55;
export const POPUP_LAYER = 60;

export const OVERLAY_LAYER_CLASS = "z-50";
export const NOTIFICATION_LAYER_CLASS = "z-55";
export const POPUP_LAYER_CLASS = "z-[60]";
