import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
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
      code: ChildProcessSpawner.ExitCode(0),
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

  it.effect("setup-apply forwards the chosen secret store and refuses one outside the set", () => {
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

      // A valid store is appended as --secrets after --consented-plan, so the
      // CLI recomputes the plan_digest against the same store the plan was
      // read for (it refuses on mismatch).
      const applied = yield* agentstack.action({
        workspaceRoot: "/proj",
        action: "setup-apply",
        planDigest: digest,
        secretsDestination: "env",
      });
      expect(applied.ok).toBe(true);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: [
            "--manifest-dir",
            "/proj",
            "init",
            "--yes",
            "--consented-plan",
            digest,
            "--secrets",
            "env",
          ],
        }),
      );

      // A store outside the closed set is refused BEFORE anything spawns —
      // fail-closed boundary hygiene (the digest binding is the real guard).
      run.mockClear();
      const bad = yield* agentstack.action({
        workspaceRoot: "/proj",
        action: "setup-apply",
        planDigest: digest,
        secretsDestination: "bogus" as never,
      });
      expect(bad.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

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

  it.effect(
    "session-start binds the profile name and refuses a malformed one before spawning",
    () =>
      Effect.gen(function* () {
        const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
          Effect.succeed(okOutput("\u2713 session 'dev' started (project)")),
        );
        const ProcessRunnerTest = Layer.succeed(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run }),
        );
        const agentstack = yield* AgentstackCli.make().pipe(Effect.provide(ProcessRunnerTest));

        const started = yield* agentstack.action({
          workspaceRoot: "/proj",
          action: "session-start",
          profile: "dev",
        });
        expect(started.ok).toBe(true);
        // Fixed argv: name in, no scope, no overrides.
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            args: ["--manifest-dir", "/proj", "session", "start", "dev"],
          }),
        );

        run.mockClear();
        // Absent or malformed names are refused before anything spawns; the
        // CLI's own fail-closed gate (trust, pins) is the real enforcement.
        const missing = yield* agentstack.action({
          workspaceRoot: "/proj",
          action: "session-start",
        });
        expect(missing.ok).toBe(false);
        for (const bad of ["../evil", "a b", "--scope", ""]) {
          const refused = yield* agentstack.action({
            workspaceRoot: "/proj",
            action: "session-start",
            profile: bad,
          });
          expect(refused.ok).toBe(false);
        }
        expect(run).not.toHaveBeenCalled();
      }),
  );

  it.effect("session-end maps to the fixed revert argv", () =>
    Effect.gen(function* () {
      const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
        Effect.succeed(
          okOutput("\u001b[32m\u2713\u001b[39m session ended \u2014 your tools are back to before"),
        ),
      );
      const ProcessRunnerTest = Layer.succeed(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({ run }),
      );
      const agentstack = yield* AgentstackCli.make().pipe(Effect.provide(ProcessRunnerTest));

      const ended = yield* agentstack.action({ workspaceRoot: "/proj", action: "session-end" });
      expect(ended.ok).toBe(true);
      // The CLI's colored output reaches the panel stripped of ANSI codes.
      expect(ended.message).toBe("\u2713 session ended \u2014 your tools are back to before");
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["--manifest-dir", "/proj", "session", "end"] }),
      );
      // Never `--all`: the panel only ever ends its own project's session.
      expect(run.mock.calls[0]?.[0].args).not.toContain("--all");
    }),
  );

  it("profileEditArgv builds preview and apply argv for each verb", () => {
    const digest = `sha256:${"cd".repeat(32)}`;

    // Enroll an existing library skill: preview is a bare --preview (writes
    // nothing); apply presents the reviewed digest back with --yes --consented.
    expect(
      AgentstackCli.profileEditArgv("/proj", {
        kind: "add-skill-to-profile",
        profile: "web",
        name: "pdf",
      }),
    ).toEqual([
      "--manifest-dir",
      "/proj",
      "add-skill-to-profile",
      "--profile",
      "web",
      "--name",
      "pdf",
      "--preview",
    ]);
    expect(
      AgentstackCli.profileEditArgv(
        "/proj",
        { kind: "add-skill-to-profile", profile: "web", name: "pdf" },
        { digest },
      ),
    ).toEqual([
      "--manifest-dir",
      "/proj",
      "add-skill-to-profile",
      "--profile",
      "web",
      "--name",
      "pdf",
      "--yes",
      "--consented",
      digest,
    ]);

    // Enroll an existing server: no --type is emitted (both preview and apply
    // omit it identically, so the CLI's digest lines up).
    expect(
      AgentstackCli.profileEditArgv("/proj", {
        kind: "add-server-to-profile",
        profile: "web",
        name: "github",
      }),
    ).not.toContain("--type");

    // create-profile repeats --skill/--server per member and allows unresolved
    // to pass through only when asked.
    expect(
      AgentstackCli.profileEditArgv(
        "/proj",
        { kind: "create-profile", name: "web", skills: ["pdf", "sql"], servers: ["github"] },
        { digest, allowUnresolved: true },
      ),
    ).toEqual([
      "--manifest-dir",
      "/proj",
      "create-profile",
      "--name",
      "web",
      "--skill",
      "pdf",
      "--skill",
      "sql",
      "--server",
      "github",
      "--yes",
      "--consented",
      digest,
      "--allow-unresolved",
    ]);
  });

  it("validateProfileEdit refuses malformed names and out-of-shape edits", () => {
    expect(
      AgentstackCli.validateProfileEdit({
        kind: "add-skill-to-profile",
        profile: "web",
        name: "pdf",
      }),
    ).toBeNull();
    // A shell-ish or spaced name is refused before any argv is built.
    expect(
      AgentstackCli.validateProfileEdit({
        kind: "add-skill-to-profile",
        profile: "../evil",
        name: "pdf",
      }),
    ).not.toBeNull();
    // git + path together is refused (the CLI would too).
    expect(
      AgentstackCli.validateProfileEdit({
        kind: "add-skill-to-profile",
        profile: "web",
        name: "pdf",
        git: "https://x",
        path: "./skills/pdf",
      }),
    ).not.toBeNull();
    // create-profile needs at least one member; `*` is the legal skill wildcard.
    expect(
      AgentstackCli.validateProfileEdit({
        kind: "create-profile",
        name: "web",
        skills: [],
        servers: [],
      }),
    ).not.toBeNull();
    expect(
      AgentstackCli.validateProfileEdit({
        kind: "create-profile",
        name: "web",
        skills: ["*"],
        servers: [],
      }),
    ).toBeNull();
  });

  it.effect("profileEditApply refuses a missing or malformed digest before spawning", () => {
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(okOutput("applied")),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const edit = { kind: "add-skill-to-profile", profile: "web", name: "pdf" } as const;

      const missing = yield* agentstack.profileEditApply({ workspaceRoot: "/proj", edit });
      expect(missing.ok).toBe(false);
      const malformed = yield* agentstack.profileEditApply({
        workspaceRoot: "/proj",
        edit,
        consented: { digest: "sha256:nope" },
      });
      expect(malformed.ok).toBe(false);
      // A malformed COMPOSED edit is also refused before spawn.
      const badShape = yield* agentstack.profileEditApply({
        workspaceRoot: "/proj",
        edit: { kind: "add-skill-to-profile", profile: "a b", name: "pdf" },
        consented: { digest: `sha256:${"cd".repeat(32)}` },
      });
      expect(badShape.ok).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it.effect("libraryIndex reads the fixed catalog argv and surfaces the feature", () => {
    const wire = JSON.stringify({
      skills: [
        { name: "sql-review", description: "reviews SQL", origin: "library", in_manifest: false },
      ],
      servers: [
        {
          name: "github",
          provenance: "consolidated:github",
          origin: "library",
          in_manifest: false,
        },
      ],
      profiles: ["web"],
      schema_version: 1,
      features: ["profiles-v1", "profiles-edit-v1"],
    });
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(okOutput(wire)),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make().pipe(Effect.provide(ProcessRunnerTest));

      const result = yield* agentstack.libraryIndex({ workspaceRoot: "/proj" });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["--manifest-dir", "/proj", "library-index"] }),
      );
      expect(result.installed).toBe(true);
      expect(result.features).toContain("profiles-edit-v1");
      expect(result.index?.skills[0]?.name).toBe("sql-review");
      expect(result.index?.profiles).toEqual(["web"]);
    });
  });

  it.effect("toolsets runs use --list --json and surfaces profiles, session, and features", () => {
    const wire = JSON.stringify({
      path: "/proj",
      trust: "trusted",
      profiles: [
        {
          name: "dev",
          skills: ["review"],
          servers: ["github"],
          harness: "codex",
          pinned: true,
          active: true,
          blockers: [],
        },
      ],
      session: { profile: "dev", scope: "project", started_unix: 1_753_000_000 },
      schema_version: 1,
      features: ["profiles-v1", "sessions-v1"],
    });
    // An older CLI without the session fields still decodes (fields absent).
    const olderWire = JSON.stringify({ path: "/p", trust: "untrusted", profiles: [] });
    const run = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>(() =>
      Effect.succeed(okOutput(wire)),
    );
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make().pipe(Effect.provide(ProcessRunnerTest));

      const result = yield* agentstack.toolsets({ workspaceRoot: "/proj" });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ args: ["--manifest-dir", "/proj", "use", "--list", "--json"] }),
      );
      expect(result.installed).toBe(true);
      expect(result.features).toContain("sessions-v1");
      expect(result.toolsets?.profiles[0]).toMatchObject({ name: "dev", active: true });
      expect(result.toolsets?.session?.profile).toBe("dev");

      const older = AgentstackCli.parseToolsets(olderWire);
      expect(older?.profiles).toEqual([]);
      expect(older?.session).toBeUndefined();
      expect(AgentstackCli.parseToolsets("not json")).toBeNull();
    });
  });

  it("parses the setup plan with and without the envelope", () => {
    const base = {
      path: "/proj",
      manifest_path: "/proj/.agentstack/agentstack.toml",
      already_initialized: false,
      detected: [
        {
          id: "claude-code",
          display: "Claude Code",
          bin_on_path: true,
          configs: ["/home/u/.claude.json"],
        },
      ],
      servers: [{ name: "search", kind: "stdio", target: "npx search-mcp" }],
      settings_from: [],
      conflicts: [{ name: "search", other_definitions: 1 }],
      secrets: [{ reference: "SEARCH_TOKEN", origin: "server 'search' (env SEARCH_TOKEN)" }],
      secrets_destination: "keychain",
      destinations: [
        {
          id: "claude-code",
          display: "Claude Code",
          scope: "project",
          path: "/proj/.mcp.json",
          writes: ["MCP servers"],
        },
      ],
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
    // Stage 1.2: the detection evidence and destination files survive decode.
    expect(withEnvelope?.detected[0]?.configs).toEqual(["/home/u/.claude.json"]);
    expect(withEnvelope?.destinations?.[0]).toMatchObject({
      path: "/proj/.mcp.json",
      scope: "project",
      writes: ["MCP servers"],
    });
    // An older CLI (no envelope, no digest) still decodes; the apply path — not
    // the decode — is what refuses a digest-less plan.
    const without = AgentstackCli.parseSetupPlan(JSON.stringify(base));
    expect(without).not.toBeNull();
    expect(without?.plan_digest).toBeUndefined();
    expect(without?.schema_version).toBeUndefined();
    // A CLI predating Stage 1.2 (no configs/destinations) still decodes.
    const preStage12 = AgentstackCli.parseSetupPlan(
      JSON.stringify({
        ...base,
        detected: [{ id: "claude-code", display: "Claude Code" }],
        destinations: undefined,
      }),
    );
    expect(preStage12).not.toBeNull();
    expect(preStage12?.detected[0]?.configs).toBeUndefined();
    expect(preStage12?.destinations).toBeUndefined();
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

  const workflowSummary = (name: string) => ({
    name,
    declared: true,
    trusted: true,
    lock_status: "matches",
    roles: ["mapper", "reducer"],
    max_agents: 4,
    max_wall_seconds: 600,
  });

  // Route the workflow()'s three reads by argv: `runs` and `report` get inert
  // (empty / null) payloads so only the LIST read — the negotiation source —
  // varies per test. No running run means `report` is never reached.
  const workflowRun = (list: string) =>
    vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>((input) =>
      Effect.succeed(okOutput(input.args.includes("runs") ? JSON.stringify({ runs: [] }) : list)),
    );

  it.effect("workflow surfaces the enveloped list features and stays compatible", () => {
    const list = JSON.stringify({
      workflows: [workflowSummary("mapreduce")],
      schema_version: 1,
      features: ["workflow-observe-v1"],
    });
    const run = workflowRun(list);
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const result = yield* agentstack.workflow({ workspaceRoot: "/proj" });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ["--manifest-dir", "/proj", "workflow", "list", "--json"],
        }),
      );
      expect(result.installed).toBe(true);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0]?.name).toBe("mapreduce");
      expect(result.features).toEqual(["workflow-observe-v1"]);
      expect(result.incompatible).toBeNull();
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it.effect("workflow reports incompatibility when the list schema outruns support", () => {
    const list = JSON.stringify({
      workflows: [workflowSummary("mapreduce")],
      schema_version: 2,
      features: ["workflow-observe-v1"],
    });
    const run = workflowRun(list);
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const result = yield* agentstack.workflow({ workspaceRoot: "/proj" });
      // Features still surface; the panel gates on `incompatible` and shows the
      // upgrade notice rather than a half-read monitor.
      expect(result.incompatible).toEqual({ cliSchema: 2, supported: 1 });
      expect(result.features).toEqual(["workflow-observe-v1"]);
      expect(result.workflows).toHaveLength(1);
    }).pipe(Effect.provide(ProcessRunnerTest));
  });

  it.effect("workflow treats a legacy un-enveloped list as no features, still parsing", () => {
    // An older binary emits the same objects WITHOUT the envelope keys.
    const list = JSON.stringify({ workflows: [workflowSummary("mapreduce")] });
    const run = workflowRun(list);
    const ProcessRunnerTest = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run }),
    );

    return Effect.gen(function* () {
      const agentstack = yield* AgentstackCli.make();
      const result = yield* agentstack.workflow({ workspaceRoot: "/proj" });
      expect(result.installed).toBe(true);
      expect(result.workflows).toHaveLength(1);
      expect(result.features).toEqual([]);
      expect(result.incompatible).toBeNull();
    }).pipe(Effect.provide(ProcessRunnerTest));
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
