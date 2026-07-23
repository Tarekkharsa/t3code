/**
 * A tiny cross-component signal for the AgentStack header panel.
 *
 * The panel lives in the chat header, but things elsewhere (a guard-denial
 * card in the message timeline) want to open it on a specific tab — e.g.
 * "View in audit log" jumps to the Activity tab. Rather than thread a
 * callback through the tree, they bump this store; the panel reacts to the
 * monotonic nonce so repeated requests (even to the same tab) re-fire.
 */
import { create } from "zustand";

export type AgentstackPanelTab = "overview" | "workflow" | "activity" | "policy";

interface AgentstackPanelStore {
  /** Increments on each open request; 0 means "never requested". */
  openNonce: number;
  requestedTab: AgentstackPanelTab;
  requestOpen: (tab: AgentstackPanelTab) => void;
}

export const useAgentstackPanelStore = create<AgentstackPanelStore>((set) => ({
  openNonce: 0,
  requestedTab: "overview",
  requestOpen: (tab) => set((s) => ({ openNonce: s.openNonce + 1, requestedTab: tab })),
}));
