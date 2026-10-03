# Project memory (experimental, unreleased)

Project memory keeps explicit operator notes across separate sessions. It is
local, inspectable and correctable. No provider calls, external database,
credentials or integrations are needed to manage it. Suggestions are never
generated automatically; hosts may submit a suggestion for operator review.

## CLI

Use `zhx` or `zhivex-code` with a matched next-version Harness engine. Commands
print bounded JSON, including the selected workspace/scope hashes. Quote content
as one argument. Memory commands do not start a model or read credentials.

```sh
zhx memory remember "Database migrations use SQLite" --source "Operator decision"
zhx memory list
zhx memory read <id>
zhx memory update <id> <revision> "Database migrations need explicit review"
zhx memory forget <id> <revision>
zhx memory suggest "Candidate database convention" --source "Model suggestion, reviewed separately"
zhx memory read <suggestion-id>
zhx memory accept <suggestion-id> <reviewed-revision>
zhx memory context "database migrations"
zhx memory disable
zhx memory enable
zhx memory clear
zhx run --no-memory "Inspect database migrations"
```

`remember` and `update` are explicit operator writes. `suggest` creates a pending
record; editing it leaves it pending. `accept` requires the exact revision that
the operator reviewed. No model tool can remember, update, accept or forget a
record. Host applications must keep these write operations behind their own
operator interface; an API call is not proof of human consent. `--source` is a
user-supplied provenance label, not a verified citation or execution receipt.
Records retain origin, creation/update/review timestamps and revision. API writes
can specify `expiresAt`; expired entries remain inspectable but are not retrieved.

`disable` persists opt-out for this project and scope and blocks writes/acceptance.
Read, list, forget and clear remain available. `clear` removes all pending and
accepted entries while preserving the opt-out setting. `--no-memory` disables
retrieval for one local run/chat/resume invocation. Service mode does not accept
this flag: the service host owns runtime configuration.

## Scope and bounds

Scope always includes the canonical workspace directory and the existing
tenant/user/namespace fields. Existing `--workspace`, `--state-dir`, `--tenant`,
`--user` and `--namespace` flags select it explicitly. The default namespace is
already workspace-derived. Even with a shared state directory and the same
explicit namespace, separate workspace directories remain isolated. A renamed
or copied project gets a different binding; there is no automatic merge, global
scope, Git-remote identity inference or cross-user permission inference. Directory
symlink aliases of the same canonical workspace use the same project. These
scope labels are host-owned selectors, not authentication: users with access to
the same OS-owned database can edit it directly.

| Bound | Limit |
| --- | --- |
| Accepted and pending entries together | 128 |
| Entry content | 4,096 UTF-8 bytes |
| Provenance label | 512 UTF-8 bytes |
| Current document | 256 KiB |
| Retrieved entries per model request | 3 |
| Complete rendered context, including metadata | 6,000 UTF-8 bytes |
| Freshness review interval | 30 days |

Retrieval ranks literal, case-insensitive query terms against content; ties use
update time and ID. It has no embeddings or semantic recall guarantee. Short
terms and a small English stop list are ignored. Only matching accepted entries
are selected. Entire entries that exceed the remaining budget are skipped.
`memory context "query"` exposes exactly that projection and its byte count.
Stale entries are labelled; expiry excludes them. Updating a reviewed entry
refreshes its review time. Byte limits are hard bounds, not exact model token
counts; the existing overall runtime token budget still applies. Empty memory
adds no model context.

## Engine API and trust boundary

```ts
import { openHarnessProjectMemory } from "@zhivex-ai/harness/engine";
const memory = await openHarnessProjectMemory({ workspace, stateDirectory, scope });
try {
  const note = memory.remember({ content: "Use reviewed migrations", source: "Operator" });
  memory.update(note.id, note.revision, { content: "Review SQLite migrations", source: "Operator correction" });
  console.log(memory.list(), memory.retrieve("SQLite migrations"));
} finally { memory.close(); }
```

`openHarnessProjectMemory`, its types, constants and the host command dispatcher
are experimental `/engine` additions. No client protocol commands or remote
service endpoints are added. Local CLI hosts explicitly enable curated project memory and project relevant
notes on every model request, including resumed runs. Engine hosts opt in with
`createHarness({ projectMemory: true, ... })`; false or omission preserves the
historical SDK memory integration and opens no curated store. This also applies
to caller-supplied run stores. Caller-supplied SDK `memory` remains an explicit
host integration and is independent of this feature's opt-out setting.

Memory reaches the model in a labelled user-context message before the current
user request, never as system instructions. The projection is ephemeral and is
not appended to durable run messages. It cannot grant approvals, change execution
or filesystem permissions, bypass tool policy, certify checks, or create skills.
Runtime approval checks still apply even when a remembered note claims authority.
This is an enforced separation of permission state; a model can still be influenced
by malicious text and must not be assumed immune to prompt injection.

Only explicit content is persisted. Tool output, repository files, conversation
summaries and model responses are not silently converted into curated memory.
Known secret patterns are rejected and the existing host secret guard still
applies. Pattern checks are best effort: they can miss secrets or reject innocent
text. Do not store credentials or private material you do not want retained.

## Storage, deletion and compatibility

Memory reuses `operations.sqlite` and the SDK's existing `zhivex_agent_memory`
table with a reserved, fully project/scope-bound key. A versioned envelope in the
existing row format holds current records and the enabled setting. There is no
second memory database or vector store. File-backed run hosts use the same SQLite
state index that already serves sessions. Writes use SQLite transactions and
expected revisions so concurrent edits cannot silently replace newer records.

Forget and clear remove content from the active row; earlier revisions and
deleted-content tombstones are not retained by this feature. SQLite secure-delete
is enabled for writes, but WAL pages, filesystem snapshots and previous backups
can still retain bytes. This is not forensic erasure. Existing run histories,
legacy SDK memory rows, exported state, host logs and model/provider transcripts
have separate retention. If a model quotes a memory in its response, that quote
may enter run history. Deleting a memory does not rewrite those histories.
Explicitly importing an older backup can restore a previously forgotten note.

New state exports include the bound project document using the existing memory
record shape. Imports validate the envelope/binding, preserve opt-out, and reject
different destination content; identical imports remain idempotent. Historical
v1 backups without project memory still import. Older importers reject a backup
with the new reserved record because it is not a run-bound SDK memory record;
use the next-version engine to restore such backups. Whole-database host snapshots
already include the row. There is no configuration or SQL table schema migration.

Legacy automatic last-assistant SDK records are not promoted into curated memory.
The stable engine default preserves its historical SDK memory integration.
Explicit curated mode, including local CLI hosts, stops automatic last-assistant
capture; caller-provided SDK memory remains supported. The API additions can
ship in a future Harness minor release with a matched next Code release and
updated exact engine dependency. Any broader removal of the stable SDK memory
default would require a major release under [API stability](STABILITY.md). Candidate package versions remain Harness
1.3.0 / Code 0.2.0 for development only: they are not publishable replacements for
the already released artifacts. Release preparation must select new versions,
update the Code pin and rerun the release gates. Nothing in this change publishes
a version.

No terminal layout, menu or visual design changes are included. A future `/memory`
console flow needs coordination with the separate TUI audit/proposals task.
