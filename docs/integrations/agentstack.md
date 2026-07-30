# AgentStack

[AgentStack](https://tarekkharsa.github.io/agentstack/) is a vendor-neutral
environment manager for AI coding tools: you define an agent setup once — MCP
servers, skills, instructions — and it compiles that definition into the native
configuration each coding CLI reads. T3 Code ships an optional panel that drives
it.

The panel presents; it is never the enforcement boundary. Every plan, write,
consent check, and refusal belongs to the AgentStack CLI, which re-validates
each one whether or not the panel asked nicely. A bug in this UI can break the
panel; it cannot grant authority the CLI would have withheld.

## Requirements

The panel appears when an `agentstack` binary is on `PATH`. To point T3 Code at
a specific build (a local release build, say):

```bash
export T3CODE_AGENTSTACK_BIN=/path/to/agentstack
```

The panel reads that same variable at runtime, and the "not installed" card
names it.

## What the panel does

Six things, matching the product's own ladder:

- **Setup** — render the plan `agentstack init --plan` detected and apply it.
  The apply is bound to the exact plan shown; if a CLI config changed in
  between, the CLI refuses and asks for a fresh review.
- **Status** — one state (Ready, Needs you, Needs setup) and one recommended
  next action, with the full doctor report as the detail layer.
- **Toolsets** — browse the library, create a toolset, edit its membership,
  rename it, delete it, and use one temporarily.
- **Review this project** — the trust gate, naming the exact servers, targets,
  secrets, skills, and workflows the repo declares before you approve them.
- **Drift review** — what changed on disk versus what AgentStack last wrote,
  per target and per scope.
- **Undo** — revert this project's most recent AgentStack-managed write.

Observation surfaces (brokered calls, workflow runs, protection posture) are
read-only.

## Version negotiation

Every AgentStack JSON read carries `schema_version` and a `features` list naming
the end-to-end contracts that binary actually serves. The panel gates each
affordance on a contract name rather than sniffing for a field, so:

- a CLI newer than this build understands disables the affected surface and says
  which side to update;
- a CLI missing a contract simply does not show that affordance — it never fires
  an action and then reads the failure.

To see what your binary advertises:

```bash
agentstack doctor --json | jq '{schema_version, features}'
```

The authoritative list lives in the CLI at `crates/cli/src/ui_contract.rs`, and
the [AgentStack integrations page](https://tarekkharsa.github.io/agentstack/integrations.html)
maps each panel capability to the contract behind it.

## Authorization

Reads take the orchestration read scope. Every action that changes AgentStack
state — applying a plan, granting trust, writing a toolset edit, installing the
guard — requires the dedicated `agentstack:admin` scope, which owner sessions
carry and standard delegated clients do not. Starting the project's servers for
a startup test is authorized the same way: it runs declared code, so it sits
with the writes even though nothing is written.

Consent is separate from authorization and enforced independently. A preview
returns a digest of the content that produced it; the apply must echo that
digest back, and the CLI refuses a stale or missing one. The digest proves the
picture you approved still holds — not that a human looked at it, which is what
the admin scope is for.

## Limits worth knowing

- Not everything the CLI can do is in the panel, by design. Registry search,
  arbitrary server and skill authoring, instructions, generic policy editing,
  secret-value entry, export/import, sign/verify, sandbox and lockdown
  execution, and workflow authoring or running are terminal work. The CLI is the
  complete interface.
- Refusals come from the CLI and are shown as written. If the panel says a
  change was refused, running it in a terminal refuses identically — updating
  AgentStack will not help.
- T3 Code injects its own browser-preview MCP endpoint directly into sessions,
  outside native CLI configuration, so that endpoint is not declared in the
  project manifest or lockfile.
- T3 Code's most permissive provider modes can disable a coding CLI's own
  approval prompts. `agentstack doctor` reports guard coverage, which matters
  more in those sessions.
- There is no AgentStack surface in `apps/mobile`.
