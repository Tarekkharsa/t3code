import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentstackCli from "./AgentstackCli.ts";

/**
 * End-to-end witness for the consent contract (AgentStack Stage 0 gate): the
 * REAL agentstack binary driven through the same service the panel RPCs use.
 * Proves preview → grant with the matching digest works, a stale digest from
 * before an edit is refused by the CLI (not just by this server), and revoke
 * returns the project to untrusted.
 *
 * Runs only when `T3CODE_AGENTSTACK_BIN` points at an existing binary —
 * absent (CI without an agentstack checkout) the suite skips, it never fails.
 * All state is confined to temp dirs: the spawned CLI inherits this process's
 * env, so pointing `AGENTSTACK_HOME` at a temp dir keeps the machine's real
 * trust store untouched.
 */
const binary = process.env.T3CODE_AGENTSTACK_BIN?.trim();
const available = binary !== undefined && binary !== "" && NodeFS.existsSync(binary);

const SURFACE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const MANIFEST_V1 = `version = 1

[servers.docs]
type = "http"
url = "https://docs.example/mcp"
`;

// One added server: the reviewed surface changes, so the v1 digest must die.
const MANIFEST_V2 = `${MANIFEST_V1}
[servers.extra]
type = "http"
url = "https://extra.example/mcp"
`;

describe.skipIf(!available)("AgentstackCli against the real binary", () => {
  it.effect(
    "trust flow end-to-end: preview → grant → drift refuses stale digest → revoke",
    () =>
      Effect.gen(function* () {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agentstack-e2e-home-"));
        const project = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agentstack-e2e-proj-"));
        const savedHome = process.env.AGENTSTACK_HOME;
        process.env.AGENTSTACK_HOME = home;
        try {
          NodeFS.mkdirSync(NodePath.join(project, ".agentstack"));
          const manifestPath = NodePath.join(project, ".agentstack", "agentstack.toml");
          NodeFS.writeFileSync(manifestPath, MANIFEST_V1);

          const cli = yield* AgentstackCli.make();

          // Preview: untrusted, with the digest the grant must present back.
          const first = yield* cli.trustPreview({ workspaceRoot: project });
          expect(first.installed).toBe(true);
          expect(first.preview).not.toBeNull();
          expect(first.preview?.state).toBe("untrusted");
          const digest = first.preview?.surface_digest;
          expect(digest).toMatch(SURFACE_DIGEST_RE);

          // Grant bound to the previewed digest succeeds…
          const grant = yield* cli.action({
            action: "trust-grant",
            workspaceRoot: project,
            consentedDigest: digest as string,
          });
          expect(grant.ok).toBe(true);

          // …and the CLI now reports the project trusted.
          const trusted = yield* cli.trustPreview({ workspaceRoot: project });
          expect(trusted.preview?.state).toBe("trusted");

          // Edit the manifest: the surface drifts and its digest changes.
          NodeFS.writeFileSync(manifestPath, MANIFEST_V2);
          const drifted = yield* cli.trustPreview({ workspaceRoot: project });
          expect(drifted.preview?.state).toBe("drifted");
          const freshDigest = drifted.preview?.surface_digest;
          expect(freshDigest).toMatch(SURFACE_DIGEST_RE);
          expect(freshDigest).not.toBe(digest);

          // The race: granting with the pre-edit digest must be refused by
          // the CLI itself — the store keeps the old pin, state stays drifted.
          const stale = yield* cli.action({
            action: "trust-grant",
            workspaceRoot: project,
            consentedDigest: digest as string,
          });
          expect(stale.ok).toBe(false);
          const afterStale = yield* cli.trustPreview({ workspaceRoot: project });
          expect(afterStale.preview?.state).toBe("drifted");

          // Re-reviewing the fresh surface grants cleanly.
          const regrant = yield* cli.action({
            action: "trust-grant",
            workspaceRoot: project,
            consentedDigest: freshDigest as string,
          });
          expect(regrant.ok).toBe(true);
          const retrusted = yield* cli.trustPreview({ workspaceRoot: project });
          expect(retrusted.preview?.state).toBe("trusted");

          // Revoke returns the project to untrusted.
          const revoke = yield* cli.action({
            action: "trust-revoke",
            workspaceRoot: project,
          });
          expect(revoke.ok).toBe(true);
          const revoked = yield* cli.trustPreview({ workspaceRoot: project });
          expect(revoked.preview?.state).toBe("untrusted");
        } finally {
          if (savedHome === undefined) {
            delete process.env.AGENTSTACK_HOME;
          } else {
            process.env.AGENTSTACK_HOME = savedHome;
          }
          NodeFS.rmSync(home, { recursive: true, force: true });
          NodeFS.rmSync(project, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)))),
    20_000,
  );
});
