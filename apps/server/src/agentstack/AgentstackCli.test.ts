import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentstackCli from "./AgentstackCli.ts";

describe("AgentstackCli", () => {
  it.effect("reports agentstack as not installed when spawning returns ENOENT", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: "agentstack",
          argumentCount: 4,
          cause: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            pathOrDescriptor: "agentstack",
          }),
        }),
      ),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const status = yield* agentstack.status({ workspaceRoot: "/tmp/workspace with spaces" });

      expect(status).toMatchObject({
        installed: false,
        version: null,
        doctor: null,
      });
      expect(status.checkedAt).toEqual(expect.any(Number));
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith({
        command: "agentstack",
        args: ["--manifest-dir", "/tmp/workspace with spaces", "doctor", "--json"],
        timeout: "15 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 2 * 1024 * 1024,
        outputMode: "truncate",
      });
    }).pipe(Effect.provide(ProcessRunnerTest));
  });
});
