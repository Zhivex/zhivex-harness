# Engine API and Code integration

This checkout adds terminal-independent package entrypoints for
Harness 1.3.0-rc.2. They are not present in the previously published Harness 1.2.0.
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
is `0.1.0-rc.1`, prepared for independent publication to `next` with the exact
engine dependency `@zhivex-ai/harness@1.3.0-rc.2`. Publication remains gated by
reviewed main, CI and registry evidence in the [Code release procedure](CODE_RELEASE.md).
Code imports declared package APIs, never Harness source paths. Its build leaves
Harness external.

Code owns `zhivex-code`. Harness 1.x continues to own `zhx`, `zhivex-harness` and
`zhx-acp`, preserving commands, flags, exit codes, JSON contracts and state paths.
The Code version/help identify the terminal product; engine diagnostics continue
to identify Harness. The historical CLI stays a Harness compatibility snapshot,
without a Harness dependency on Code. Desktop keeps its existing internal bridge
until HAR-HU-39 migrates it separately.

Node >=22.13.0 is the runtime requirement. Bun builds and tests the source but is
not required to install or run the JavaScript tarballs. Consumer projects retain
their own package manager and lockfile.

## Contributor validation

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
and cancellation without live keys. This is deterministic installed evidence,
not provider certification or a registry release. Historical HU37/38 reports
used temporary 1.3.0-dev.0 metadata; those reports do not certify RC1.

`dev:code` explicitly links the built local Harness for contributor tests; it
preserves an existing dependency and is never run by package installation.
Installed acceptance uses tarballs instead of that link. The CI workflow defines
the same four-manager check on Node 22.13.0 and Node 24; a workflow definition is
not evidence that remote CI has run.

The architecture gate follows transitive imports, re-exports and type references
from the engine surfaces, rejecting CLI/Desktop/Code dependencies and computed
module loads. Code has separate checks for public-package imports and manifest/bin
ownership. Stable root declaration signatures are checked without regenerating
the baseline to accommodate this extraction.

Publishing Code requires a compatible Harness release, authenticated scope/name
verification and the release compatibility gates in
[ADR 0001](https://github.com/Zhivex/zhivex-harness/blob/main/docs/adr/0001-harness-code-public-boundary.md).
Local packing does not establish npm permissions or public availability.
