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

  const okOutput = (stdout: string) =>
    ({
      stdout,
      stderr: "",
      code: 0,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    }) as const;

  it.effect("diff runs the scoped diff --json and parses the report", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(
        okOutput(
          JSON.stringify({
            scope: "global",
            drifted: 1,
            targets: [
              {
                id: "claude-code",
                display: "Claude Code",
                path: "/Users/x/.claude.json",
                changed: true,
                diff: "- old\n+ new",
                kept: ["figma"],
              },
            ],
            warnings: [],
          }),
        ),
      ),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const result = yield* agentstack.diff({ workspaceRoot: "/proj", scope: "global" });

      expect(result.installed).toBe(true);
      expect(result.report).toMatchObject({ scope: "global", drifted: 1 });
      expect(result.report?.targets[0]).toMatchObject({ changed: true, kept: ["figma"] });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["--manifest-dir", "/proj", "diff", "--json", "--scope", "global"],
        }),
      );
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it.effect("maps drift actions to scope-correct argv and never passes --prune-foreign", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(okOutput("done")),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();

      yield* agentstack.action({ workspaceRoot: "/proj", action: "adopt-global" });
      yield* agentstack.action({ workspaceRoot: "/proj", action: "apply-global" });
      yield* agentstack.action({ workspaceRoot: "/proj", action: "adopt-project" });
      yield* agentstack.action({ workspaceRoot: "/proj", action: "apply-project" });

      const argvs = run.mock.calls.map((c) => c[0].args);
      expect(argvs[0]).toEqual([
        "--manifest-dir",
        "/proj",
        "adopt",
        "--scope",
        "global",
        "--write",
      ]);
      expect(argvs[1]).toEqual([
        "--manifest-dir",
        "/proj",
        "apply",
        "--scope",
        "global",
        "--write",
      ]);
      expect(argvs[2]).toEqual([
        "--manifest-dir",
        "/proj",
        "adopt",
        "--scope",
        "project",
        "--write",
      ]);
      expect(argvs[3]).toEqual([
        "--manifest-dir",
        "/proj",
        "apply",
        "--scope",
        "project",
        "--write",
      ]);
      // The destructive prune flag is never emitted from the panel.
      expect(argvs.flat()).not.toContain("--prune-foreign");
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it.effect("trust-grant presents the consented digest and refuses without one", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(okOutput("trusted")),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );
    const digest = `sha256:${"ab".repeat(32)}`;

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();

      // The consent binding (§7.2): a grant carries the previewed digest.
      const granted = yield* agentstack.action({
        workspaceRoot: "/proj",
        action: "trust-grant",
        consentedDigest: digest,
      });
      expect(granted.ok).toBe(true);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [
            "--manifest-dir",
            "/proj",
            "trust",
            "/proj",
            "--yes",
            "--consented-digest",
            digest,
          ],
        }),
      );

      // No digest (older CLI preview / older client) and a malformed digest
      // both refuse BEFORE anything spawns — never downgraded to bare --yes.
      run.mockClear();
      const absent = yield* agentstack.action({ workspaceRoot: "/proj", action: "trust-grant" });
      expect(absent.ok).toBe(false);
      expect(absent.message).toContain("surface digest");
      const malformed = yield* agentstack.action({
        workspaceRoot: "/proj",
        action: "trust-grant",
        consentedDigest: "sha256:nope",
      });
      expect(malformed.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it("decodes surface_digest from the preview and tolerates its absence", () => {
    const base = {
      path: "/proj",
      state: "untrusted",
      re_trust: false,
      servers: [],
      secrets: [],
      counts: { skills: 0, workflows: 0, extensions: 0, instructions: 0 },
    };
    const digest = `sha256:${"cd".repeat(32)}`;
    const withDigest = AgentstackCli.parseTrustPreview(
      JSON.stringify({ ...base, surface_digest: digest }),
    );
    expect(withDigest?.surface_digest).toBe(digest);
    // An older binary's preview (no field) still decodes — the grant path,
    // not the decode, is what refuses.
    const without = AgentstackCli.parseTrustPreview(JSON.stringify(base));
    expect(without).not.toBeNull();
    expect(without?.surface_digest).toBeUndefined();
  });

  it("parses the workflow run history and degrades to [] on unknown shapes", () => {
    const wire = JSON.stringify({
      runs: [
        {
          run: "w-abc123",
          workflow: "mapreduce-acceptance",
          outcome: "running",
          exhausted: false,
          resumable: false,
          started_unix: 1_784_792_723,
          duration_ms: null,
          steps: 5,
        },
        {
          run: "w-def456",
          workflow: "mapreduce-acceptance",
          outcome: "interrupted",
          exhausted: false,
          resumable: true,
          started_unix: 1_784_790_000,
          duration_ms: 26_340,
          steps: 3,
        },
      ],
    });
    const runs = AgentstackCli.parseWorkflowRuns(wire);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.outcome).toBe("running");
    expect(runs[1]?.resumable).toBe(true);
    // An older binary's error text (or any non-history payload) is never a throw.
    expect(AgentstackCli.parseWorkflowRuns("error: unrecognized subcommand")).toEqual([]);
    expect(AgentstackCli.parseWorkflowRuns(JSON.stringify({ runs: [{ run: 1 }] }))).toEqual([]);
  });
});
