# Source architecture

Harness keeps its runtime package, a separately built Code terminal package in
`packages/code`, and a separately built Desktop application. Additive public
[engine entrypoints](ENGINE_API.md) expose the motor independently of terminal
presentation. Persisted-state and client protocol versions remain unchanged.

The proposed future split between Harness and Code is recorded in
[ADR 0001](adr/0001-harness-code-public-boundary.md). It inventories the current
boundary and defines the compatible migration. HAR-HU-37/38 implement the additive
engine interfaces and local Code package; Desktop migration and release
certification remain separate work.

## Module ownership

| Folder | Responsibility |
| --- | --- |
| `runtime/` | Agent composition, configuration, policies, budgets, repair and diagnostics |
| `approvals/` | Approval history, diffs and review previews |
| `workspace/` | Safe file access, edits, change envelopes and mutation locks |
| `execution/` | Isolated OCI execution, processes and package manager detection |
| `persistence/` | Run/session stores, SQLite ownership, backups and state validation |
| `providers/` | Provider catalog, capabilities and model routing |
| `context/` | Project context, compaction, metrics and task memory |
| `integrations/` | MCP clients and configuration |
| `client/` | Client protocol, dispatch, local transport and activity events |
| `cli/` | Commands and presentation, with `console/` and `terminal/` subfolders |
| `tools/` | Tool definitions and registration |
| `internal/desktop/` | Explicit integration surfaces consumed by Desktop |
| `engine/` | Explicit public entrypoints without terminal implementation |
| `compat/` | Shared CLI option contracts and named Code host helpers |

Only `index.ts`, `cli.ts`, `service-cli.ts` and `version.ts` remain at the source
root, together with `cli-entry.ts` and `acp-cli.ts`. All except `version.ts` are
public/build entrypoints. `version.ts` stays beside
them so its package metadata lookup has the same relative path in source and
bundled Node entrypoints. The architecture check rejects new root modules.

Internal source paths are not public package exports. Repository consumers,
tests and tooling follow the grouped paths; the supported package-root exports,
binary paths and stable declaration signatures remain unchanged.

## Client protocol and execution

- `src/client/protocol.ts` defines schemas and client types. Its only runtime
  dependency is Zod. References to session, approval and SDK types are erased.
- `src/client/adapter.ts` implements negotiation, command dispatch, idempotency,
  revision checks, approval admission and cancellation against the host runtime.
- `src/client/local-service.ts` owns the authenticated local transport.
- `src/client/index.ts` collects client exports for the package root.
  Internal consumers import the protocol or adapter directly.

## Runtime composition and tools

`src/runtime/harness.ts` composes the agent, persistence, policies and execution lifecycle.
Workspace tool definitions live in `src/tools/workspace.ts`; isolated execution
tools live in `src/tools/execution.ts`. `src/tools/shared.ts` owns their common
approval metadata, verifier diagnostics and terminal checkpoint identity.
Tools must not load the harness composition root. Existing public tool factories
remain available through `src/runtime/harness.ts` and the package root.

The checkpoint symbol and verification error class have one shared owner so
cancellation callbacks and error classification remain identical across modules.

## CLI

`src/cli.ts` owns process entry, command dispatch and compatibility re-exports.
The `src/cli/` modules separate argument parsing, help, presentation, routing,
runtime construction, run/review/resume commands, interactive conversation,
provider setup, diagnostics, and run/session/change/state management.
Resume metadata has a dedicated module. Implementation modules never import the
executable facade; they depend directly on the module owning a capability.

## Desktop integration

Desktop consumes declared exports from an installed Harness candidate:

| Surface | Responsibility |
| --- | --- |
| `/protocol` | Browser-compatible request schema and erased client/activity types |
| `/engine` and `/desktop/v1/providers` | Model/configuration construction and host credential/catalog helpers |
| `/models` | Renderer-only catalog metadata without provider/authentication imports |
| `/service` | Local-service transport, authentication and recovery |
| `/desktop/v1/state` | Host-only snapshots, state validation, file safety and SQLite ownership |

Desktop cannot import Harness repository source (including internal bridges),
undeclared deep package paths, the broad compatibility root, or Code. The gate
enforces these rules for imports and re-exports, including type references.
Renderer uses `/models` and `/protocol`; host capabilities remain behind preload/IPC.
The runtime never imports Desktop. Existing internal bridge files are no longer
consumed by the application.

`prepare:desktop` installs the candidate tarball in a private consumer. Build
bundles only that installed package and records its artifact hash; no source or
version/SQLite rewrite plugins are used. See [Desktop development](../desktop/DEVELOPMENT.md)
for the exact candidate compatibility constraint and the distinction from the
previously deployed RC3 bytes.

## Code integration

Code owns its terminal source and independent build/tests in `packages/code`.
It imports the named Harness subpaths, with no source-relative links. The existing
Harness CLI remains a compatibility snapshot for its 1.x binaries. Shared wire
serialization, result documents and continuation reconstruction live in `client/`;
old CLI paths are re-export bridges. Public CLI option contracts live in `compat/`.
Harness has no dependency on Code. The same public build uses shared chunks to
preserve class and schema identity across entrypoints.

## Enforcement and verification

`bun run architecture:check` checks static imports, re-exports, literal dynamic
imports, `require` calls and import types. It runs in the main `check` gate and
Desktop CI. Computed module paths are not a supported way to cross these boundaries.
The architecture tests also bundle the Desktop protocol for a browser to catch
accidental transitive host dependencies.

Refactors must preserve `bun run contract:check`, including the existing stable
declaration signatures; do not regenerate that baseline just to accommodate file
movement. Existing client, CLI, approval, execution and Desktop regression suites
verify behavior. Packaged runtime and Desktop smoke tests validate the bundled
entrypoints separately from source checks.
