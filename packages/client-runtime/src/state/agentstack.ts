import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createAgentstackEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackStatus,
      label: "agentstack.status",
    }),
    activity: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackActivity,
      label: "agentstack.activity",
    }),
    workflow: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackWorkflow,
      label: "agentstack.workflow",
    }),
    trustPreview: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackTrustPreview,
      label: "agentstack.trustPreview",
    }),
    diff: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackDiff,
      label: "agentstack.diff",
    }),
    action: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackAction,
      label: "agentstack.action",
    }),
  };
}
