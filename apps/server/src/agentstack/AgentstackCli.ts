import {
  AgentstackCallEvent,
  AgentstackDoctorReport,
  type AgentstackActivity,
  type AgentstackStatus,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const COMMAND_TIMEOUT = "15 seconds";
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/** Re-probe the CLI version at most this often (it changes on upgrades). */
const VERSION_PROBE_TTL = Duration.minutes(5);

/**
 * Server-internal request: the workspace root is always resolved from the
 * orchestration projections by the caller (see the `agentstack.status` RPC
 * handler in `ws.ts`), never taken from a client.
 */
export interface AgentstackStatusRequest {
  readonly workspaceRoot: string;
}

/** Server-internal request for the recent-calls feed; same path rule. */
export interface AgentstackActivityRequest {
  readonly workspaceRoot: string;
  readonly limit: number;
}

/** Bounds for the `--tail` the CLI is asked for, whatever the client sent. */
export const ACTIVITY_LIMIT_MAX = 50;
export const ACTIVITY_LIMIT_DEFAULT = 8;

const decodeDoctorReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentstackDoctorReport),
);

export function parseDoctorReport(stdout: string) {
  return Option.getOrNull(decodeDoctorReport(stdout));
}

// Only the `events` array matters here; the rest of the report shape may
// grow without breaking this decoder. Absent/invalid input degrades to [].
const decodeCallEvents = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ events: Schema.Array(AgentstackCallEvent) })),
);

export function parseCallEvents(stdout: string): ReadonlyArray<AgentstackCallEvent> {
  return Option.match(decodeCallEvents(stdout), {
    onNone: () => [],
    onSome: (r) => r.events,
  });
}

function isBinaryNotFound(error: ProcessRunner.ProcessRunError): boolean {
  return (
    error._tag === "ProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  );
}

export class AgentstackCli extends Context.Service<
  AgentstackCli,
  {
    readonly status: (input: AgentstackStatusRequest) => Effect.Effect<AgentstackStatus>;
    readonly activity: (input: AgentstackActivityRequest) => Effect.Effect<AgentstackActivity>;
  }
>()("t3/agentstack/AgentstackCli") {}

export const make = Effect.fn("AgentstackCli.make")(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const configuredBinary = process.env.T3CODE_AGENTSTACK_BIN?.trim();
  const binary = configuredBinary ? configuredBinary : "agentstack";
  const run = (args: ReadonlyArray<string>) =>
    processRunner.run({
      command: binary,
      args,
      timeout: COMMAND_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: MAX_STDOUT_BYTES,
      outputMode: "truncate",
    });
  const versionCache = yield* Cache.make({
    capacity: 1,
    timeToLive: VERSION_PROBE_TTL,
    lookup: () =>
      run(["--version"]).pipe(
        Effect.map((result) => {
          if (result.timedOut || result.stdoutTruncated) return null;
          const version = result.stdout.trim();
          return version.length > 0 ? version : null;
        }),
        Effect.orElseSucceed(() => null),
      ),
  });

  const status: AgentstackCli["Service"]["status"] = Effect.fn("AgentstackCli.status")(
    function* (input) {
      const doctorResult = yield* run([
        "--manifest-dir",
        input.workspaceRoot,
        "doctor",
        "--json",
      ]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (result) => ({ _tag: "Success", result }) as const,
        }),
      );

      if (doctorResult._tag === "NotFound") {
        return {
          installed: false,
          version: null,
          doctor: null,
          checkedAt: yield* Clock.currentTimeMillis,
        };
      }

      return {
        installed: true,
        version: yield* Cache.get(versionCache, "version"),
        doctor:
          doctorResult._tag === "Success" ? parseDoctorReport(doctorResult.result.stdout) : null,
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  const activity: AgentstackCli["Service"]["activity"] = Effect.fn("AgentstackCli.activity")(
    function* (input) {
      const limit = Math.min(Math.max(1, Math.trunc(input.limit)), ACTIVITY_LIMIT_MAX);
      const result = yield* run([
        "--manifest-dir",
        input.workspaceRoot,
        "report",
        "calls",
        "--json",
        "--tail",
        String(limit),
        "--project",
        input.workspaceRoot,
      ]).pipe(
        Effect.match({
          onFailure: (error) =>
            isBinaryNotFound(error)
              ? ({ _tag: "NotFound" } as const)
              : ({ _tag: "Failed" } as const),
          onSuccess: (result) => ({ _tag: "Success", result }) as const,
        }),
      );
      return {
        installed: result._tag !== "NotFound",
        events: result._tag === "Success" ? parseCallEvents(result.result.stdout) : [],
        checkedAt: yield* Clock.currentTimeMillis,
      };
    },
  );

  return AgentstackCli.of({ status, activity });
});

export const layer = Layer.effect(AgentstackCli, make()).pipe(Layer.provide(ProcessRunner.layer));
