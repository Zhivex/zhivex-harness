# ADR 0001: Public boundary between Harness and Code

Status: proposed for review (HAR-HU-36). Date: 2026-09-28.

This records a design, not a completed package extraction or permission to publish.
The inspected source is `0865d09ec24ec0a26219a295910097845843c8c0` (manifest 1.2.0).
The [evidence report](../reports/HAR_HU_36_2026-09-28.md) and
[complete inventory](../reports/HAR_HU_36_PUBLIC_BOUNDARY_2026-09-28.json) distinguish
the existing surface from the proposed one. The story and parent plan are in
[Notion](https://app.notion.com/p/3e8777b104f6810688dedffdcb9732b3).

## Problem and decision

Harness currently ships a library and CLI together. Desktop bundles repository
source through four internal surfaces. The package root exports terminal helpers,
and client implementation modules import code under `cli/`. Moving that folder
wholesale to Code would introduce reverse dependencies or break consumers.

Adopt a monorepo with independently built/versioned `@zhivex-ai/harness` (engine)
and proposed `@zhivex-ai/code` (terminal product), plus the existing private Desktop
application. Code and Desktop consume explicit Harness package exports. Harness
must never import Code or Desktop, including through type-only or dynamic imports.
The engine is not `@zhivex-ai/core`: that existing SDK package continues to own
SDK model/message primitives and remains a dependency with its existing name.

The intended package dependency graph is acyclic:

```text
Code ------------> Harness engine/client/service/ACP ----> Zhivex SDK
Desktop ---------> Harness engine/client/service
Service hosts ---> Harness engine/client/service
Harness 1.x compatibility facade ---> Harness engine + frozen compatibility code
```

This is a package boundary rule, not a claim that every existing source module
graph is cycle-free. The current architecture checker does not prove the new
boundary or all transitive cycles. The migration gates below must enforce it.

## Ownership and proposed exports

All subpaths below are proposed, additive interfaces for HAR-HU-37/39; none exist
in today's package manifest. Their exact named exports and stability tiers must
be enumerated in the contract before shipping. No wildcard source-path exports.
Existing names keep their tiers; a new alias does not downgrade a stable contract.

| Capability | Owner and intended interface | Existing source / migration constraint |
| --- | --- | --- |
| Execution, config, policies, approvals, context, tools, provider registry, persistence | Harness `/engine`: `createHarness`, config/model factories and their named types; terminal-free integration entrypoint | `runtime/`, `approvals/`, `workspace/`, `execution/`, `persistence/`, `context/`, `tools/`, `providers/`, `models/`, `integrations/`; retain root aliases |
| Wire schemas and client types | Harness `/protocol`: protocol version, request/command schemas, client and activity types | `client/protocol.ts`, `client/json-contracts.ts`; browser bundle must not load Node, provider clients or terminal code |
| In-process adapter | Harness `/client`: `createHarnessClientAdapter` and named adapter types | `client/adapter.ts`; negotiation, revisions, idempotency, cancellation and approval admission stay engine-owned |
| Local service and activity store | Harness `/service`: start/recover/request/read-credentials functions, local credential schema, `openHarnessActivityStore` and types | `client/local-service.ts`, `client/service-events.ts`; Node-only; no CLI process startup on import |
| ACP adapter and stream transport | Harness `/acp`: `createAcpConnection`, `serveAcpStdio` and named types | `client/acp.ts`, `client/acp-stdio.ts`; streams supplied by host; existing experimental text-session subset only |
| Terminal commands, prompts, console, onboarding and rendering | Code executable and private implementation; avoid a new public Code library until needed | `cli.ts`, `cli-entry.ts`, presentation/console/terminal modules; no Desktop dependency on Code |
| Provider secret acquisition | Code owns CLI prompts/keychain adapter; Desktop owns its credential UI/helper; Harness consumes explicitly supplied models/credentials/environment | `cli/cli-credentials.ts`, `desktop/src/credential-store.ts`; preserve precedence and secret-redaction behavior; no interactive prompting in engine |
| Local-service authentication secret | Harness `/service` | Distinct from provider API keys; retain local transport authentication, file permissions and recovery semantics |
| Desktop state/backup/SQLite coordination | Harness named host-only state API, proposed `/state`; Desktop owns installer/update transaction and presentation | Audit each `internal/desktop/persistence.ts` export; never blindly publish `SqliteDatabase` or file helpers as a stable client API; retain internal bridge until a supported replacement exists |
| Desktop model catalog | Harness proposed `/models`, named browser-safe catalog data/types; model creation/loading via host engine APIs | Split the current `internal/desktop/providers.ts` host and renderer use; model selection must not bring provider credentials into renderer |

The full inventory lists all 436 root exports by source, kind and tier: 73 stable,
127 beta and 36 experimental runtime exports; 48 stable, 108 beta and 44
experimental type exports. Classification remains in
[`contracts/public-api.json`](../../contracts/public-api.json), with stable
declaration closures in
[`contracts/stable-api-signatures.json`](../../contracts/stable-api-signatures.json).
The inventory also includes CLI commands/options and config, CLI JSON/event,
operations, sessions, MCP, envelope, edit and backup schema contracts.

## Resolve existing cross-boundary dependencies first

1. Move `cli/cli-stream.ts` serialization and `cli/run-document.ts` result
   projection to engine-owned client/document modules. Preserve stable
   `CLI_JSON_SCHEMA_VERSION`, `CLI_EVENT_SCHEMA_VERSION`, `serializeStreamEvent`
   and `serializeStreamResult` root names and byte/schema semantics. They serve
   clients as well as terminal presentation despite their current names.
2. Move `cli/terminal/terminal-continuation.ts` transcript reconstruction into an
   engine-owned continuation module. `client/adapter.ts` already consumes it;
   it must not depend on a terminal product or replay unrecorded tool effects.
3. Keep `CLI_COMMAND_OPTION_CONTRACTS`, `CLI_OPTION_DEFINITIONS`, `CLI_OPTION_NAMES`,
   `validateCliCommandOptions` and their four stable types available at the root
   through an engine-owned compatibility contract module. Code consumes that
   common definition; do not maintain conflicting validators.
4. Keep the eleven beta terminal exports (seven values and four types) at the
   1.x root as a compatibility implementation. The new `/engine` dependency
   closure excludes them. Code may initially reuse the compatibility helpers;
   Harness must not re-export them from the Code package. A pure root requires
   a later major; a pure additive engine subpath can ship in 1.x.
5. Separate process wiring from configuration in `acp-cli.ts`: today it imports
   CLI argument parsing, profiles and `createConfiguredHarness`, which also
   imports `ConsoleInput` and presentation. ACP protocol remains in Harness;
   interactive product setup belongs to Code and the old launcher stays a 1.x
   compatibility entrypoint. Keep ACP stdout reserved for protocol traffic.
6. Migrate Desktop's `protocol`, `providers`, `runtime` and `persistence` bridges
   to the appropriate named package APIs, retaining Electron preload/IPC and
   renderer boundaries. Its current build bundles source, rewrites version
   metadata and patches SQLite loading: HAR-HU-39 must replace those assumptions
   with installed-package evidence, not just change import strings.

## 1.x distribution and binary transition

The existing manifest owns `zhx` and `zhivex-harness` at `dist/zhx.js` and
`dist/cli.js`, plus experimental `zhx-acp` at `dist/acp-cli.js`.
`dist/service-cli.js` is a built host entrypoint, not a registered npm binary;
preserve its documented invocation and Desktop use while consumers migrate.

During 1.x, Harness retains those names, paths, command meanings, flags, exit
codes and root aliases. Code initially declares only the distinct proposed
`zhivex-code` binary; its availability must be checked in HAR-HU-38. It must not
claim `zhx`, `zhivex-harness` or `zhx-acp` while compatible Harness versions ship
them. Never use install scripts, symlink overwrites or `--force` to resolve a
collision. This permits both packages in either installation order.

Retain the historical CLI as a bundled compatibility snapshot within Harness
1.x. It depends only on engine APIs and in-package compatibility code; there is
no runtime dependency or optional dependency from Harness to Code. A future build
may generate the snapshot from the same terminal sources, but must build engine
first and bundle a pinned source revision: it must not require an installed or
published Code package to build/publish Harness. Updating that snapshot is an
explicit Harness change with its own gates; Code releases do not mutate it.
Code declares a tested Harness version range and ships its own Node executable;
Desktop pins and verifies its own compatible engine version.

Retiring legacy exports/binaries requires a subsequent Harness major, a documented
migration and changelog notice for at least one minor release beforehand, and
installed-consumer proof under [the existing policy](../DEPRECATIONS.md). Transfer
of `zhx` to Code is not decided by this ADR: old Harness 1.x installations remain
possible even after a major. A later decision must handle co-installation or keep
the unique Code name. No bin takeover is implied by a version bump.

Package extraction alone must not change state directories, keychain identifiers,
config/schema versions, approval fingerprints, backup readers or recovery rules.
CLI and Desktop opening the same state keep the existing ownership/locking and
revision checks. Any necessary change needs a separately reviewed migration.

## Acceptance gates for the implementation stories

| Story | Required evidence before acceptance |
| --- | --- |
| HAR-HU-37 | Named terminal-free engine/protocol exports; root signatures unchanged; client document/continuation regressions; import under Node without TTY/stdin access or keychain prompts; protocol bundles for browser; reject direct/transitive reverse imports |
| HAR-HU-38 | Code tarball consumes only declared Harness exports; Node executable and onboarding/CLI behavior; distinct bin manifest; scoped name and publish authority checked; no publication inferred from packing |
| HAR-HU-39 | Desktop build and restart/recovery smoke against installed Harness, no relative source imports/version or SQLite source patch; renderer has no host/secret dependency; provider/protocol/state surfaces verified |
| HAR-HU-40 | Both install orders, uninstall either package, isolated installs, minimum/latest supported Harness range, stable API/CLI/state fixtures, independent build/release checks and preserved legacy paths |

Use Bun for contribution tooling. Retain Node >=22.13.0 for this proposal unless
a separately justified compatibility decision changes it. Consumers must be able
to install standard tarballs with npm, pnpm, Yarn or Bun and run Node without Bun
installed or install scripts requiring it. HAR-HU-40 records exact manager/runtime
versions tested, minimum Node and a current supported Node; certify Bun runtime
separately if advertised. Respect consumer lockfiles and package managers.

Enforcement must analyze static, re-export, type-only, literal dynamic/require and
transitive package edges; disallow computed imports across package boundaries.
Validate the built manifests and tarball contents as well as source. Existing
`architecture:check` and `contract:check` are necessary but insufficient for the
future split. Keep deterministic, installed, live and registry evidence separate.

## Name and permission check

Read-only checks on 2026-09-28 reached registry.npmjs.org after retrying outside
the network-restricted sandbox. `npm view @zhivex-ai/code name version --json`
returned E404; `npm whoami` and `npm org ls zhivex-ai --json` returned E401.
The name is not visible to this session. This does not prove availability or
authorization: private visibility, package restrictions and scope rights remain
unverified. No token was displayed, login changed, name reserved or package
published. `npm publish --dry-run` would not prove registry write permission.

Before accepting the complete third criterion, an authenticated scope owner must
verify identity and scope/package rights, then record a sanitized result. Before
release, recheck name/rights and the release identity (including package-specific
trusted publishing/2FA policy). Do not make a test publication to check access.

## Alternatives and consequences

- Moving all of `cli/` directly would make client/service code depend on Code;
  rejected because it creates a reverse package edge.
- Making Harness launch an installed Code dependency would create a cycle with
  Code's engine dependency; rejected.
- Removing terminal exports or transferring bins in a minor breaks compatibility;
  rejected. The tradeoff is a compatibility CLI snapshot until a reviewed major.
- A new generic shared package is unnecessary now. Shared protocol, state and
  policy semantics belong to Harness; SDK Core keeps its existing responsibility.

The proposal is ready for review without altering runtime behavior. Extraction
can proceed through the linked stories after architectural review; name/authority
remains an explicit outstanding check, and this ADR is not release certification.
