# Source architecture

Harness keeps one runtime package and a separately built Desktop application.
The internal boundaries below are co-versioned; they do not introduce new public
package entrypoints or change the persisted-state and client protocol versions.

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

Only `index.ts`, `cli.ts`, `service-cli.ts` and `version.ts` remain at the source
root. The first three are public/build entrypoints. `version.ts` stays beside
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

Desktop consumes four explicitly enumerated surfaces in `src/internal/desktop/`:

| Surface | Responsibility |
| --- | --- |
| `protocol.ts` | Browser-compatible request schema and erased client/activity types |
| `providers.ts` | Provider catalog and host-side model/configuration construction |
| `runtime.ts` | Host runtime construction and local-service transport |
| `persistence.ts` | Host-only state validation, backup, file safety and SQLite ownership |

Desktop source must not import other runtime source paths, even for types. Add a
reviewed, named export to the appropriate surface when a new integration is needed.
The surfaces are internal source interfaces, not independently versioned packages.
Renderer code uses the protocol surface; host capabilities remain behind the
existing preload/IPC boundary. The runtime never imports Desktop.

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
