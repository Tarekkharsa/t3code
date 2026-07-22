import { createAgentstackEnvironmentAtoms } from "@t3tools/client-runtime/state/agentstack";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentstackEnvironment = createAgentstackEnvironmentAtoms(connectionAtomRuntime);
