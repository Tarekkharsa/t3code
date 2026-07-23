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

  it.effect(
    "setup-apply presents the consented plan digest and refuses without a valid one",
    () => {
      const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
        Effect.succeed(okOutput("initialized")),
      );
      const ProcessRunnerTest = Layer.succeed(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({ run }),
      );
      const digest = `sha256:${"ab".repeat(32)}`;

      return Effect.gen(function* () {
        const agentstack = yield* AgentstackCli.make();

        // Plan binding (§ mirrors trust-grant): the reviewed plan_digest is
        // presented back as --consented-plan; NO --secrets flag (both plan read
        // and apply default to keychain, so the digests line up).
        const applied = yield* agentstack.action({
          workspaceRoot: "/proj",
          action: "setup-apply",
          planDigest: digest,
        });
        expect(applied.ok).toBe(true);
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ["--manifest-dir", "/proj", "init", "--yes", "--consented-plan", digest],
          }),
        );
        expect(run.mock.calls[0]?.[0].args).not.toContain("--secrets");

        // Absent and malformed digests both refuse BEFORE anything spawns.
        run.mockClear();
        const absent = yield* agentstack.action({ workspaceRoot: "/proj", action: "setup-apply" });
        expect(absent.ok).toBe(false);
        expect(absent.message).toContain("plan digest");
        const malformed = yield* agentstack.action({
          workspaceRoot: "/proj",
          action: "setup-apply",
          planDigest: "sha256:nope",
        });
        expect(malformed.ok).toBe(false);
        expect(run).not.toHaveBeenCalled();
      }).pipe(Effect.provide(ProcessRunnerTest));
    },
  );

  it.effect("restore-write undoes by id and refuses a malformed id before spawning", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(okOutput('{"performed":true}')),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );
    const id = "18c4e1d2ef6e44d0";

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();

      const undone = yield* agentstack.action({
        workspaceRoot: "/proj",
        action: "restore-write",
        restoreId: id,
      });
      expect(undone.ok).toBe(true);
      // Undoes one entry by id — never a blind --last.
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["--manifest-dir", "/proj", "restore", id, "--write", "--json"],
        }),
      );
      expect(run.mock.calls[0]?.[0].args).not.toContain("--last");

      run.mockClear();
      const missing = yield* agentstack.action({ workspaceRoot: "/proj", action: "restore-write" });
      expect(missing.ok).toBe(false);
      const bad = yield* agentstack.action({
        workspaceRoot: "/proj",
        action: "restore-write",
        restoreId: "../etc/passwd",
      });
      expect(bad.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it("parses the setup plan with and without the envelope", () => {
    const base = {
      path: "/proj",
      manifest_path: "/proj/.agentstack/agentstack.toml",
      already_initialized: false,
      detected: [{ id: "claude-code", display: "Claude Code" }],
      servers: [{ name: "search", kind: "stdio", target: "npx search-mcp" }],
      settings_from: [],
      conflicts: [{ name: "search", other_definitions: 1 }],
      secrets: [{ reference: "SEARCH_TOKEN", origin: "server 'search' (env SEARCH_TOKEN)" }],
      secrets_destination: "keychain",
    };
    const digest = `sha256:${"ab".repeat(32)}`;
    const withEnvelope = AgentstackCli.parseSetupPlan(
      JSON.stringify({
        ...base,
        plan_digest: digest,
        schema_version: 1,
        features: ["apply-setup"],
      }),
    );
    expect(withEnvelope?.plan_digest).toBe(digest);
    expect(withEnvelope?.features).toEqual(["apply-setup"]);
    expect(withEnvelope?.detected[0]?.display).toBe("Claude Code");
    // An older CLI (no envelope, no digest) still decodes; the apply path — not
    // the decode — is what refuses a digest-less plan.
    const without = AgentstackCli.parseSetupPlan(JSON.stringify(base));
    expect(without).not.toBeNull();
    expect(without?.plan_digest).toBeUndefined();
    expect(without?.schema_version).toBeUndefined();
    expect(AgentstackCli.parseSetupPlan("not json")).toBeNull();
  });

  it("parses the restore inventory including touches_project", () => {
    const wire = JSON.stringify({
      entries: [
        {
          id: "18c4e1d2ef6e44d0",
          short_id: "18c4e1d2",
          time_unix: 1_784_799_648,
          scope: "project",
          summary: "1 file · claude-code, codex",
          undone: false,
          touches_project: true,
        },
      ],
      adapter_backups: [],
      schema_version: 1,
    });
    const inventory = AgentstackCli.parseRestoreInventory(wire);
    expect(inventory?.entries).toHaveLength(1);
    expect(inventory?.entries[0]?.touches_project).toBe(true);
    // Without the optional envelope it still decodes.
    const withoutEnvelope = AgentstackCli.parseRestoreInventory(JSON.stringify({ entries: [] }));
    expect(withoutEnvelope?.entries).toEqual([]);
    expect(AgentstackCli.parseRestoreInventory("nope")).toBeNull();
  });

  it("negotiate maps the envelope to features and schema incompatibility", () => {
    // Absent envelope (older CLI) → features [], compatible.
    expect(AgentstackCli.negotiate(null)).toEqual({ features: [], incompatible: null });
    expect(AgentstackCli.negotiate({})).toEqual({ features: [], incompatible: null });
    // Same/older schema → features surfaced, compatible.
    expect(AgentstackCli.negotiate({ schema_version: 1, features: ["apply-setup"] })).toEqual({
      features: ["apply-setup"],
      incompatible: null,
    });
    // Newer schema → incompatible carries both version numbers.
    expect(AgentstackCli.negotiate({ schema_version: 2, features: ["x"] })).toEqual({
      features: ["x"],
      incompatible: { cliSchema: 2, supported: AgentstackCli.SUPPORTED_AGENTSTACK_SCHEMA },
    });
  });

  it.effect("status surfaces schema incompatibility and the feature list from doctor", () => {
    const doctor = JSON.stringify({
      errors: 0,
      warnings: 0,
      state: "ready",
      sections: [],
      schema_version: 2,
      features: ["apply-setup", "restore-last"],
    });
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>((input) =>
      Effect.succeed(okOutput(input.args.includes("--version") ? "agentstack 0.16.0" : doctor)),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const status = yield* agentstack.status({ workspaceRoot: "/proj" });
      expect(status.installed).toBe(true);
      expect(status.incompatible).toEqual({ cliSchema: 2, supported: 1 });
      expect(status.features).toEqual(["apply-setup", "restore-last"]);
    }).pipe(Effect.provide(ProcessRunnerTest));
  });
});
