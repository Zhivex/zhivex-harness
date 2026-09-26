# Trusted repository editing

Zhivex Harness `0.3.x` adds conflict-safe multi-file editing while preserving the `0.2.x` workspace boundary. Discovery is read-only. Every mutation requires interrupt approval, validates the content the operator reviewed, and produces an audit entry.

## Safety model

Repository editing does not grant arbitrary shell access or Git write access. The harness never stages, commits, resets, pushes, or permanently deletes a file on behalf of the model.

The following rules apply to every operation:

- paths are workspace-relative and must remain inside the canonical workspace;
- symbolic-link escapes and special files are rejected;
- hierarchical `.gitignore` files, `.zhivex-harnessignore`, built-in build/state exclusions, and hard secret exclusions are applied during discovery;
- hard secret exclusions such as `.env`, `.npmrc`, private keys, Git internals, and harness state cannot be re-enabled by an ignore rule;
- output, file size, page size, check, and execution-time limits remain bounded;
- writes, moves, quarantine operations, restores, and checks require an interruptible approval.

These controls prevent silent workspace drift; they do not isolate the host. Run autonomous work in a disposable workspace or enforced environment.

## Discovery and digests

`list_files` and `search_files` return deterministic pages. `list_files` keeps digest-bound entries as the default; set `includeDigests=false` for path-only topology discovery without reading every file. Before proposing a mutation, use `read_file` or `read_files` to obtain the exact current digest. Each response includes `truncated` and, when another page exists, an opaque `nextCursor`. Supply that cursor unchanged to request the next page. A cursor is bound to the original operation and parameters, including the topology/digest mode; it must not be edited or reused for a different path, query, case-sensitivity setting, or page size.

In `0.9.x`, pagination reuses a topology-only index. Before each reuse, the harness validates visible directory metadata and the metadata plus content digests of applicable ignore files. A structural or ignore-policy change invalidates the index and makes an older cursor fail as stale. File bytes and content digests are never served from that index: every listed page, read, and search uses the stable anti-race file reader, so an external content-only change is observed even when the topology remains valid.

Use `read_files` for up to 20 independent file/range requests with a 2 MiB aggregate source limit; duplicate paths share one stable read. Use `search_many` for up to 10 literal queries and 500 aggregate matches; it reads each candidate file once for the whole query set. The single-file tools remain available for focused reads and cursor-paginated search. Batch tools are read-only and do not enable global tool parallelism, so write ordering and approval behavior are unchanged.

Listed files and every search match include a content digest. `read_file` also returns the digest of the complete file, even when only a line range was requested. Digests are the concurrency contract for later edits: reading content and then editing it without carrying the observed digest does not provide stale-workspace protection.

Ignore rules affect discovery, not direct authorization. A direct request for a hard-protected path still fails. An ignored ordinary source file can only be addressed when the workspace policy explicitly permits the direct operation.

## Propose and apply

Multi-file edits use two phases:

1. `propose_edits` receives the intended final content for every target plus the digest observed during inspection. Use `expectedDigest: null` only when the target must not exist.
2. The proposal result identifies the canonical proposal and summarizes every target without modifying the workspace.
3. `apply_patch` repeats the reviewed changes and proposal identifier. The harness verifies the canonical proposal, rechecks every precondition, and pauses for approval before writing.
4. If any target was created, removed, replaced, or otherwise changed after inspection, the complete apply is rejected as stale before publishing the proposed changes.

Successful file replacement uses same-directory staging and atomic per-file publication. Every target is preflighted before publication begins, existing file modes are preserved, and a new file receives the harness default regular-file mode. If later publication fails, the harness attempts to roll back the already-published targets and reports the failure. The patch result contains the proposal identifier and one mutation audit entry per changed path.

Structured editing documents use schema version `1`:

| Tool | `kind` | Payload |
| --- | --- | --- |
| `propose_edits` | `edit-proposal` | `proposalId`, `digestAlgorithm`, and redacted change summaries. |
| `apply_patch` | `patch-result` | Workspace mutation result. |
| `move_file` | `move-result` | Workspace move result. |
| `quarantine_file` | `quarantine-result` | Workspace quarantine result and recovery identifier. |
| `restore_file` | `restore-result` | Workspace restore result. |
| `mutation_audit` | `mutation-audit` | Mutation audit entries for this harness instance. |
| `git_diff` | `workspace-diff` | Status, diff evidence, and mutation audit entries. |

The proposal document never returns file contents. Its `proposalId` binds the normalized paths, expected digests, resulting content digests, and byte counts that were reviewed.

`expectedDigest` is not an optional optimization. It distinguishes three cases:

| Value | Required precondition |
| --- | --- |
| Existing file digest | The regular file must still contain exactly the inspected bytes. |
| `null` | The path must still be absent. |
| Missing field | Invalid mutation request. |

The harness does not merge conflicting edits. Reinspect the file, review the new content, and create a new proposal.

The terminal prints the complete `apply_patch` approval arguments rather than truncating them, including when a paused run is resumed. This is intentionally more verbose than other approvals: approving a patch confirms the exact final contents shown. `--yes` bypasses interactive review and should only be used in a disposable or isolated workspace.

## Move, quarantine, and restore

`move_file` requires the current source digest and a destination that does not already exist. It preserves the regular-file mode and records both paths. It does not invoke `git mv`; Git detects the resulting rename from repository contents.

`quarantine_file` requires the current digest and moves the file into harness-owned state. The result includes a `quarantineId` used for recovery. The model has no permanent-delete tool.

`restore_file` accepts a quarantine identifier and an optional workspace destination. Restore is conflict-safe: it never overwrites an existing destination, and an optional expected digest can bind the operation to the quarantined bytes the operator reviewed. A successful restore is recorded independently from the quarantine operation.

Quarantine is a recovery boundary, not a backup system. Retention and permanent cleanup remain operator responsibilities. Do not manually edit quarantine manifests or payloads while a run is active.

## Checks

Checks remain explicit package scripts executed through the repository package manager. `packageManager` is authoritative when pinned; otherwise one unambiguous npm, pnpm, Yarn, or Bun lockfile is detected, and repositories without either default to npm. `test`, `typecheck`, `lint`, and `build` are the default allowlist. `--allow-check` and `ZHIVEX_HARNESS_ALLOWED_CHECKS` replace that default with an explicit set of declared package-script names; they do not accept command text. The requested script text must still exactly match the current `package.json`; a changed script, symbolic-link/ambiguous lockfile, or implicit `pre<check>`/`post<check>` hook fails closed.

Checks do not load the workspace `.env` automatically. A non-zero exit, timeout, or truncated output is recorded as returned evidence and must not be summarized as a successful validation.

## Git inspection and final summary

`git_diff` is read-only and reports the repository status, unstaged diff, and staged diff as separate results, including renamed, deleted, and untracked paths. `mutation_audit` returns the harness mutation history for the current workspace process.

With enforced OCI execution, `git_diff` is intentionally omitted from the model tool set because the Git repository remains on the canonical host outside the snapshot boundary. The model reviews `mutation_audit` and the content-bound environment patch instead; the CLI/library result reports canonical host Git evidence after an approved import.

Every mutation audit entry includes an identifier, operation, affected path, timestamp, and the available before/after digest evidence. Move and restore operations may include a destination; quarantine-related entries may include a quarantine identifier.

Before completion, an editing run should report:

- files inspected and whether discovery was truncated;
- proposal and mutation results;
- stale conflicts or denied approvals;
- checks executed with their exit status;
- final staged, unstaged, renamed, deleted, and untracked state;
- quarantine identifiers that the operator may need for recovery.

Audit entries document harness operations. They do not prove that another process did not modify the repository, so the final Git inspection remains required.

## Migration from 0.2.x

`0.3.0` is a pre-1.0 minor release and deliberately tightens mutation contracts:

- replace overwrite-oriented editing with inspect plus digest-bound proposal/apply for multi-file changes;
- consume paginated discovery until `nextCursor` is absent instead of assuming one list/search result is complete;
- configure the allowed check subset explicitly when the default set is too broad;
- use quarantine and restore instead of deleting or manually moving a file out of the workspace;
- include mutation audit evidence and the expanded Git status in final summaries.

Existing source files need no migration. Existing Git state is not modified during upgrade. Persisted `0.2.x` runs should be completed with the version that created them before beginning `0.3.x` editing work; do not assume a paused approval created under an older tool schema can be resumed after upgrading.

The new quarantine and audit state is harness-owned and must remain excluded from model discovery and Git. Back up any recovery payloads that must outlive the local retention window before cleaning harness state.

## Known limits

- Atomic publication protects each file and failed batches use best-effort rollback; the workspace is not a database transaction across power loss, rollback failure, or external concurrent processes.
- Git rename detection is heuristic and may display a delete plus add for heavily rewritten content.
- Ignore evaluation and filesystem behavior can differ by platform; Linux and macOS fixtures are required release gates.
- Quarantine does not replace version control or an external backup.
- With the default `execution=none`, checks use the narrow host check runner and generic shell remains unavailable. With `execution=oci`, repository tools and checks operate on a secret-free snapshot and only a separately approved digest-bound environment patch may change the host workspace.

## Small exact replacements

`apply_reviewed_replacement` accepts `path`, the inspected `expectedDigest`,
`oldText`, and `newText`. Its approval binds those complete arguments. The old
text must occur exactly once, including whitespace; there is no regular expression
or ambiguous global replacement. The runtime reconstructs the full content and
reuses the atomic patch path, rechecking the digest before publication. A stale
approval cannot overwrite intervening changes. UTF-8 validity, BOM, CRLF, unrelated
bytes, filesystem policy and mutation auditing remain enforced. OCI edits still
require an independently approved patch import.

Prefer this tool for a small repair in a large file, so the model need not emit the
whole file. `apply_reviewed_edits` remains available for new files and complete
replacements. Default file reads now return up to 120 lines; request an explicit
range for more. `search_many` defaults to 10 matches per query; narrow the path or
request a higher limit when the response is truncated.

## Audit remediation: search, filesystem and execution continuity

`search_files` accepts an exact file or directory. Both search tools cap match
payloads; `search_many` additionally includes cursor/metadata overhead in its
32000-character response ceiling. Truncated groups provide `nextCursor` for
`search_files` with the same query, path, case sensitivity and per-query limit;
a group without a cursor can be restarted individually. Exact-file cursors bind
to the file digest. `coverage` reports inspected/omitted eligible files and
`tooLarge`, `unsafe`, or `unreadable` counts. `incomplete=true` means zero matches
cannot establish absence. Normal repository exclusion rules still apply.

Safe regular-file reads now reject symlinks in every ancestor: macOS uses
`O_NOFOLLOW_ANY`, Linux walks through held directory descriptors using `/proc`.
Unsupported platforms fail closed. This closes the reproduced ancestor-swap
read race; it is not a claim of descriptor-relative publication for every write.

Governed OCI filesystem edit receipts persist in a private per-run audit across
session reacquisition. `mutation_audit` covers those direct edits; command
results and `inspect_environment_patch` provide command/aggregate evidence.
The bounded audit is not an atomic database transaction with filesystem effects;
an I/O failure must be treated as a failed operation and inspected, never assumed
to mean all effects rolled back.

Terminal verified imports own and renew a run lease, propagate the invocation
signal/deadline and revalidate revision/lease before publication. Cancellation
at publication checkpoints rolls back already published writes. Interrupting
an approval wait leaves its durable pending approval available for inspection;
it never authorizes later import. A concurrent filesystem actor or rollback I/O
failure can still cause a reported rollback failure; it is never a success.

## Model-facing references in 1.2 RC3

When using `runHarness` or delegating to its implementer subagent, read existing files with `read_file` or `read_files` before
requesting `apply_reviewed_replacement`, `apply_reviewed_edits`, or
`verify_and_apply_reviewed_edits`. Models supply paths and edits; the runtime
binds the full-file digest from the preceding successful read. Full-file changes
use `create: true` only for new files. Existing files must be read again after
changes or when compaction has removed the reference evidence.

After `inspect_environment_patch`, models call `apply_environment_patch` with
`{}` or `verify_and_apply_environment_patch` with exact verifier argv. The runtime
binds that inspected patch ID before the SDK requests approval. It never chooses
a new snapshot when resuming an approval. A changed snapshot or host file still
fails closed. Reads and mutations must be separate model turns.

This provider-facing view does not change direct tool schemas: programmatic
callers and persisted approval payloads still contain `expectedDigest` or
`patchId`. Explicit legacy references remain authoritative and are never repaired
or replaced silently. SDK users invoking the agent directly should continue to
use those explicit contracts.

### OCI delivery at completion

An OCI edit changes the isolated snapshot until its reviewed import is approved.
Normal assistant runs now check actual snapshot changes against host contents and
file modes before saving a completed result. If a model stops with pending changes,
the runtime can schedule up to two read-only patch inspections and remind it to
finish verification and request import through the usual approval flow. The
reminder count and import refusals survive resume; this does not enable
`requireVerifiedDelivery` or impose a repair plan on read-only work.

If delivery remains pending, completion is saved as failed with
`OCI_DELIVERY_PENDING`; an import refusal uses `OCI_DELIVERY_DECLINED`, and an
unreadable or invalid snapshot uses `OCI_DELIVERY_INSPECTION_FAILED`. These checks
cover edits made by tools or commands and apply to terminal receipts as well.
They never approve or import a patch automatically.

Parent completion also checks durable child and descendant snapshots within their
scopes. Pending delegated changes produce `OCI_CHILD_DELIVERY_PENDING`; missing
child state produces an inspection failure. A parent patch inspection cannot
deliver a child snapshot, so no parent inspection is scheduled for that case.
