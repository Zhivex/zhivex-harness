# Engine API and Code integration

This checkout adds terminal-independent package entrypoints for
Harness 1.3.0-rc.6. They are not present in the previously published Harness 1.2.0.
Publication is pending the protected workflow; use the documented
local candidate smoke to validate these bytes. Do not install registry 1.2.0 and
expect the new entrypoints to exist.

## Entry points

| Import | Use | Runtime |
| --- | --- | --- |
| `@zhivex-ai/harness/engine` | Configuration, execution, policies, approvals, tools, stores, providers and historical non-terminal library APIs | Node |
| `@zhivex-ai/harness/protocol` | Wire request schemas, client types and JSON/event serialization | Browser or Node |
| `@zhivex-ai/harness/client` | In-process client adapter, result projection and durable continuation helpers | Node |
| `@zhivex-ai/harness/service` | Authenticated local service, recovery and activity events | Node |
| `@zhivex-ai/harness/acp` | Experimental text-session ACP adapter and stream transport | Node |
| `@zhivex-ai/harness/code-support` | Named host helpers used by Code, including a read-only SQLite diagnostic projection | Node |
| `@zhivex-ai/harness/models` | Beta catalog schemas, bundled metadata, model selection and display helpers; no host loading | Browser or Node |
| `@zhivex-ai/harness/mcp/stdio/v1` | Experimental host admission, isolated MCP sessions, recovery and reconciliation; see [host flow](MCP_STDIO.md) | Node or Bun |
| `@zhivex-ai/harness/desktop/v1/state` | Versioned host-only snapshot, validation, safe-file-read and lease handoff operations for Desktop updates | Node |

[`contracts/engine-api.json`](../contracts/engine-api.json) enumerates every named
export and its stability tier. Existing aliases keep their root tier. New helpers
have their explicitly recorded tier; importing through a new subpath does not
upgrade an experimental API. The historical root export and its stable signature
baseline remain supported. Host-loading JSON document schemas are available from
`/engine`, not the browser protocol entrypoint.

Imports do not open a terminal, start a service, create a Harness instance or
prompt for credentials. Hosts explicitly construct and close the runtime, supply
credentials/model instances, resolve approvals and choose their storage policy.
Importing the engine does not itself execute a task or grant permissions.

The `/models` subpath is an **unpublished addition after RC3**, introduced for
HAR-HU-39. It is present in local candidate tarballs from this checkout, not the
previously deployed RC3 bytes. Its six runtime exports and two types are listed
in `contracts/engine-api.json`. It performs no file access, credential resolution,
provider requests or process startup. Remote catalog loading remains host-owned.
Installed-package smoke compiles the public subpath for a browser and checks its
exports and type declarations in a clean consumer. Desktop migration and packaged
app acceptance are recorded separately in the repository-only report `docs/reports/HAR_HU_39_2026-09-29.md`.

```ts
import { createHarness } from "@zhivex-ai/harness/engine";
import { createHarnessClientAdapter } from "@zhivex-ai/harness/client";

const harness = await createHarness({
  workspace: "/absolute/path/to/project",
  provider: "openai",
  model: "your-supported-model"
});
const client = await createHarnessClientAdapter(harness);
try {
  // Dispatch requests using the documented client protocol and explicit approvals.
  // Keep the host alive for the work it starts; close only when it is finished.
} finally {
  client.close();
  await harness.close();
}
```

See [the client protocol](CLIENT_PROTOCOL.md), [local service](LOCAL_SERVICE.md)
and [durable operations](DURABLE_OPERATIONS.md) for execution, approval and recovery
semantics. Persistence and approval fingerprints are shared across clients;
switching presentation does not migrate state or authorize new effects.

## Terminal product

`packages/code` is the independently built terminal product. Its current version
is `0.1.0-rc.2`, prepared for independent publication to `next` with the exact
engine dependency `@zhivex-ai/harness@1.3.0-rc.6`. Publication remains gated by
reviewed main, CI and registry evidence in the [Code release procedure](CODE_RELEASE.md).
Code imports declared package APIs, never Harness source paths. Its build leaves
Harness external.

Code owns `zhivex-code`. Harness 1.x continues to own `zhx`, `zhivex-harness` and
`zhx-acp`, preserving commands, flags, exit codes, JSON contracts and state paths.
The Code version/help identify the terminal product; engine diagnostics continue
to identify Harness. The historical CLI stays a Harness compatibility snapshot,
without a Harness dependency on Code. Desktop now consumes installed engine,
protocol, service, models and versioned host contracts; it does not import the
old internal source bridges.

Node >=22.13.0 is the runtime requirement. Bun builds and tests the source but is
not required to install or run the JavaScript tarballs. Consumer projects retain
their own package manager and lockfile.

## Contributor validation

The local candidate also adds `/desktop/v1/state`, an explicitly versioned
integration contract for trusted Desktop main/worker processes. New names are
experimental; aliases of historical names retain their existing tiers. Exact
exports are recorded in `contracts/engine-api.json`. This is not a general SQL
interface: `SqliteDatabase`, arbitrary queries and migrations are not exported.

`createHostDatabaseSnapshot`, `verifyHostDatabaseSnapshot` and
`verifyHostDatabaseState` own whole-database checks, WAL snapshots and receipt
validation. Desktop remains responsible for closing admission, stopping workers,
coordinating multiple projects, and verifying the application before restoration.
Snapshot callers supply host-controlled paths. Existing `DESKTOP_*` error codes
are preserved. The 128 MiB limit, private permissions, no-follow reads, all-scope
idle checks and logical backup validation are unchanged.

The additional file-read/path validators serve updater artifact verification and
do not authorize writes. `SqliteAccessLease` and its acquire/adopt/descriptor
operations retain the macOS cooperative lock protocol. Inherited lease adoption
requires the trusted native handoff helper; it is never a renderer IPC operation.
Different copies of the package must not exchange lease objects. Installed smoke
verifies that engine and state entrypoints in one installation share ownership.
Compatibility with older clients that do not participate in this locking
protocol is not implied.

The new subpaths are unpublished local additions after the deployed RC3.
Desktop migration and packaged acceptance are documented in
the repository-only report `docs/reports/HAR_HU_39_2026-09-29.md`. Its dependency is pinned to the
candidate version and checked for required contracts/artifact identity; this does
not claim compatibility with the earlier published RC3 bytes or a broader range.

```sh
bun run dev:code
bun run typecheck:code
bun run test:code
bun run architecture:check
bun run contract:check
bun run smoke:engine-code
```

The smoke packs the current Harness candidate without changing its version. The
release workflow supplies the exact tarball via `HARNESS_CODE_HARNESS_ARTIFACT`;
its bytes are copied, never repacked. The report identifies hashes, installed
versions and observed results. Node execution uses a restricted PATH excluding
Bun. Local fixtures exercise approval, persistence and restart, Code execution
and cancellation without live keys. Each manager has independent Harness-first
and Code-first consumers. Every installation step exercises the manager-created
launchers; final checks reject overlapping binary ownership, a reverse Code
dependency and unresolved local/workspace dependency references. Tarball overrides
use consistent relative paths to preserve Yarn Classic launchers across installs.
This is deterministic installed evidence,
not provider certification or a registry release. Historical HU37/38 reports
used temporary 1.3.0-dev.0 metadata; those reports do not certify RC1.

`dev:code` explicitly links the built local Harness for contributor tests; it
preserves an existing dependency and is never run by package installation.
Installed acceptance uses tarballs instead of that link. The CI workflow defines
the same four-manager check on Node 22.13.0 and Node 24; a workflow definition is
not evidence that remote CI has run.

For a historical version boundary, run
`bun run smoke:state-upgrade /absolute/old-harness.tgz /absolute/candidate-harness.tgz incompatible`.
This installs both supplied artifacts in separate consumers and creates a pending
approval with the historical root API. The candidate must explain its incompatible
Harness identity without model calls, file effects or changes to the pending run.
The historical runtime must then complete that run with explicit approval. Artifact
hashes and observed versions are retained in the report. This test does not rewrite
fingerprints, certify an automatic migration or verify registry provenance.
Use `compatible` instead to require an unchanged binding and candidate completion
after explicit approval. Both modes preserve historical session metadata across
candidate and historical reopen. Distinct tarball bytes are required, and the
caller chooses the expected outcome before execution; a rejected compatible case
is a failure, not silently reclassified as success.
Set `HARNESS_COMPAT_RUNTIME=/absolute/path/to/node` to select the runtime for
both installed consumers; set it to `bun` to verify Bun runtime separately from
Bun package installation. Reports record the selected executable and observed
runtime version. The installer remains Bun regardless of the selected runtime.

`bun run smoke:global-code /absolute/harness.tgz /absolute/code.tgz` tests both
global installation orders with Bun in separate temporary global and binary
directories. It checks the manager-created launchers after each install, exact
resolved engine bytes, and deterministic CLI execution with Node and no Bun in
runtime PATH. These prefixed installs do not modify the operator's global tools.
Global locations use Bun's documented `BUN_INSTALL_GLOBAL_DIR` and
`BUN_INSTALL_BIN` controls (see [Bun configuration](https://bun.com/docs/runtime/bunfig)).
The default mode certifies Bun global installation; local manager coverage remains a
separate matrix and neither test establishes registry publication or provenance.
An optional third argument supplies a historical Harness tarball. Each temporary
prefix first installs it and verifies legacy help/version, then tests both orders
of candidate Harness and Code installation. Legacy launchers are checked after
every step, including when Code is installed before upgrading Harness. The
candidate override is explicit; this is local artifact acceptance, not evidence
of registry dependency resolution or a historical Code release.
`HARNESS_GLOBAL_MANAGER=npm` selects isolated npm global prefixes. This mode
retains the exact-engine assertion and records failures per order. npm global
may resolve Code's pinned Harness from the registry instead of reusing a locally
installed tarball with the same version; such a result does not certify the local
candidate. Reports retain both orders and exit nonzero if either fails.
Set `HARNESS_GLOBAL_REGISTRY_FIXTURE=1` for npm candidate acceptance: a read-only
loopback registry child serves the supplied Harness tarball unchanged, including
its SHA-512 integrity, and redirects other package requests to the public registry.
The child closes after the smoke. Reports label this `loopback-exact-candidate`,
distinct from default registry resolution; passing it does not erase a failed
default-registry attempt or certify publication/provenance.
Global acceptance also supports `HARNESS_GLOBAL_MANAGER=pnpm` (11.x) and `yarn`
(Classic 1.x), with `SMOKE_PNPM_PATH`/`SMOKE_YARN_PATH` selecting the executables.
Both use isolated package/bin directories and explicit temporary registry config.
pnpm's separate global installation roots are inspected individually. Shell
utilities needed by generated launchers remain available; Bun is absent from the
runtime PATH. These modes should use the exact-candidate registry fixture.

The architecture gate follows transitive imports, re-exports and type references
from the engine surfaces, rejecting CLI/Desktop/Code dependencies and computed
module loads. Code has separate checks for public-package imports and manifest/bin
ownership. Stable root declaration signatures are checked without regenerating
the baseline to accommodate this extraction.

Publishing Code requires a compatible Harness release, authenticated scope/name
verification and the release compatibility gates in
[ADR 0001](https://github.com/Zhivex/zhivex-harness/blob/main/docs/adr/0001-harness-code-public-boundary.md).
Local packing does not establish npm permissions or public availability.
## Experimental task acceptance contracts

`runHarness(host, input, { taskAcceptance })` accepts application-owned requirements
for a new run. The strict `taskAcceptanceContractSchema` is exported from `/engine`.
It binds exact file paths, required check argv/backend/approval policy, and human
review requirements that remain `pending`. It does not introduce arbitrary shell
scripts or grant tool permissions. `compileTaskAcceptanceContract` provides the
canonical digest; compilation alone does not validate the workspace or authorize
execution. Runtime admission additionally validates the real workspace and host.

```ts
import {
  taskAcceptanceContractSchema, runHarness,
  inspectHarnessTaskAcceptance, reviseHarnessTaskAcceptance
} from '@zhivex-ai/harness/engine';

const contract = taskAcceptanceContractSchema.parse({
  schemaVersion: 1,
  taskId: 'repair-parser',
  allowedWritePaths: ['src/parser.ts', 'tests/parser.test.ts'],
  protectedFiles: ['package.json'],
  requiredChecks: [{
    id: 'test', kind: 'package-script', script: 'test', expectedScript: 'bun test',
    command: 'bun', args: ['--no-env-file', 'run', 'test'], purpose: 'Parser regression',
    execution: { backend: 'none', approval: 'required' }
  }],
  humanReview: [{ id: 'readability', requirement: 'Review readability', status: 'pending' }]
});
const result = await runHarness(host, { prompt: 'Repair the parser' }, { taskAcceptance: contract });
const ledger = await inspectHarnessTaskAcceptance(host, result.state.runId);
// After an operator approves changed requirements, while the run is stopped:
const state = await host.store.load(result.state.runId, host.config.scope);
await reviseHarnessTaskAcceptance(host, {
  runId: result.state.runId,
  expectedRunRevision: state!.revision!,
  expectedContractRevision: ledger!.revisions.at(-1)!.revision,
  contract: { ...contract, humanReview: [{ id: 'readability', requirement: 'Review revised behavior', status: 'pending' }] }
});
```

The package example requires a Bun-declared manifest with the exact `test` script,
an allowlisted `test` check, and a `run_check` tool. OCI argv checks use
`kind: 'argv'` and `execution: { backend: 'oci', approval: 'required', network: 'none' }`;
their executable must be in the host allowlist. File paths are exact, not globs.
Contracts are limited to 64 KiB and 32 checks. Revision history is bounded to
16 revisions/1 MiB; capacity errors never silently discard prior requirements.

Inspection reads the host's durable store. Revision uses both run and contract
revisions for compare-and-swap, rejects active runs, and invalidates acceptance
evidence. Reload the state before resuming after a revision. Contract metadata
cannot be supplied through run input; the optional third argument is the trusted
application boundary. Runs with contracts use the host's configured scope.
Resumes use the stored contract, and `read_task` exposes its current revision even
after compaction. Existing runs without a contract keep their previous behavior.

For OCI execution, imports enforce the exact allowed paths and protected files,
then require every declared check to succeed against the same contract revision,
run, environment, patch and complete snapshot bytes. Altering a package script
or changing the snapshot invalidates verification. Recovery reconciles check
receipts against the durable tool journal; ambiguous or interrupted effects are
not replayed automatically.

The host-owned `zhivexTaskAcceptanceEvidenceV1` metadata adds acceptance outcomes
without changing SDK run statuses or `ChangeEnvelope` v1. Active work is `pending`;
terminal work without sufficient delivery evidence is `incomplete`; failed runs
or scope violations are `failed`. A completed run with a normal stop becomes
`verified` only after a confirmed import and a final inspection of delivered host
files and snapshot bytes. Required human review produces `pending_review` instead.
Model prose cannot supply this evidence. The `none` backend does not receive OCI
acceptance guarantees. Recovered import metadata is diagnostic evidence only until
its delivery can be confirmed; it cannot alone restore a verified outcome.

### Portable governance projection (Experimental)

`exportHarnessGovernanceReport(store, scope, runId, options?)` reads durable runs
and journals into `HarnessGovernanceReport`. Validate portable JSON with
`harnessGovernanceReportSchema`; `renderHarnessGovernanceMarkdown(report)` renders
its bounded summary. `options.changeEnvelopes` accepts up to 32 existing v1
objects; `options.now` fixes the verification timestamp for reproducible exports.
Neither patch bytes nor producer authenticity are certified by an envelope digest.

Optional `options.session` is `{ id, index, history? }`: `index.get` and
`history.replay` must already be bound to the same workspace/scope as the run
store. The root must belong to the selected session. No current application policy
is substituted for missing historical evidence. Recorded child acceptance remains
separate from semantic review; exporting does not rerun child validation or tools.
See the CLI portable report documentation for redaction, retention and limits.

## Request context and measurements

The default engine advertises a smaller common tool catalog. `discover_tools`
loads additional authorized schemas on demand; it does not change executors,
permissions, approval requirements or execution boundaries. Applications that
supply `toolNames` without `discover_tools` retain a fully advertised explicit
catalog. An explicit `toolChoice` keeps that authorized tool advertised.

Large successful check, search, dependency and diff results can appear as bounded
excerpts with a `resultId`. `read_tool_result` retrieves 4,000-character slices of
the original evidence from the current durable run. Originals remain unchanged;
unknown references and references from another run are rejected. If no durable
source exists, the engine sends the original result instead of an unreadable
reference. A partial excerpt is not proof that an omitted error or match does
not exist. Mutation receipts and tool failures remain intact.

The optional `runHarness(..., { onDiagnostics })` callback includes
`requestMeasurements`: numeric context sizes, estimated input tokens, reported
input/output/cache tokens and terminal completion for the current invocation.
It retains at most 128 requests plus an omitted count and contains no prompt or
result text. Missing usage is null, including an interrupted paid request; these
measurements do not claim invoice accuracy or provider tokenizer equivalence.
