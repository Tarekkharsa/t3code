/**
 * A tiny cross-component signal for the AgentStack header panel.
 *
 * The panel lives in the chat header, but things elsewhere (a guard-denial
 * card in the message timeline) want to open it on a specific tab of the
 * Manage dialog — e.g. "View in audit log" jumps to Activity. Rather than
 * thread a callback through the tree, they bump this store; the panel reacts
 * to the monotonic nonce so repeated requests (even to the same tab) re-fire.
 */
import { create } from "zustand";

/**
 * The tabs of the Manage dialog — the panel's only navigation. Three, not
 * five: Protection and Sharing are reference sheets reached from the dialog's
 * corner link, not destinations something elsewhere would deep-link to.
 */
export type AgentstackPanelTab = "setup" | "toolsets" | "activity";

interface AgentstackPanelStore {
  /** Increments on each open request; 0 means "never requested". */
  openNonce: number;
  requestedTab: AgentstackPanelTab;
  requestOpen: (tab: AgentstackPanelTab) => void;
}

export const useAgentstackPanelStore = create<AgentstackPanelStore>((set) => ({
  openNonce: 0,
  requestedTab: "setup",
  requestOpen: (tab) => set((s) => ({ openNonce: s.openNonce + 1, requestedTab: tab })),
}));
