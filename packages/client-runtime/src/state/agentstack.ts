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
    workflowRun: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackWorkflowRun,
      label: "agentstack.workflowRun",
    }),
    trustPreview: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackTrustPreview,
      label: "agentstack.trustPreview",
    }),
    diff: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackDiff,
      label: "agentstack.diff",
    }),
    setupPlan: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackSetupPlan,
      label: "agentstack.setupPlan",
    }),
    toolsets: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackToolsets,
      label: "agentstack.toolsets",
    }),
    restoreInventory: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackRestoreInventory,
      label: "agentstack.restoreInventory",
    }),
    libraryIndex: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackLibraryIndex,
      label: "agentstack.libraryIndex",
    }),
    profileEditPreview: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackProfileEditPreview,
      label: "agentstack.profileEditPreview",
    }),
    profileEditApply: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackProfileEditApply,
      label: "agentstack.profileEditApply",
    }),
    action: createEnvironmentRpcCommand(runtime, {
      tag: WS_METHODS.agentstackAction,
      label: "agentstack.action",
    }),
  };
}
