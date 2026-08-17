# Changelog

All notable changes to Zhivex Harness are documented in this file.

The project follows Semantic Versioning. During `0.x`, minor releases may change user-facing contracts when the change is documented with a migration note. Patch releases remain backwards compatible bug fixes.

## 0.5.0 - 2026-08-17

### Added

- Model capability inspection, fail-fast requirements, and deterministic candidate selection before MCP or agent execution.
- Schema-versioned declarative MCP configuration with explicit server/tool allowlists, permissions, environment-backed headers, bounded discovery, timeouts, and output-size ceilings.
- A bounded HTTPS/loopback-HTTP MCP JSON-RPC client plus injectable custom clients for library consumers.
- Named `explorer`, `implementer`, `tester`, and `reviewer` subagent profiles with independent durable budgets, leases, fingerprints, and inherited workspace/scope policy.
- Application-owned parallel read-only review groups through the `review` CLI command and `runHarnessReviewGroup` library API.
- Hierarchical child progress, approval identity, usage, cost/budget aggregation, and redacted run-tree inspection.
- An opt-in Meta/Qwen/OpenAI live orchestration matrix that verifies exact reviewer delegation, child persistence, SQLite reopen, hierarchy, and aggregate usage independently from the legacy reviewed-edit gate.
- Public npm metadata, security and support policies, exact-tarball inspection and installation gates, and a confirmation-gated GitHub Actions release workflow with npm provenance.

### Changed

- Resolved configuration uses schema version `3` and binds required capabilities, normalized MCP configuration, enabled profiles, and child policy into the harness fingerprint.
- Parent and child token guards enforce aggregate durable usage after each provider step, avoiding double reservation after a child consumes budget.
- The deterministic evaluation gate adds governed MCP and bounded-subagent scenarios.

### Migration

- Review schema-version-pinned configuration and replace `schemaVersion: 2` with `3`; existing scoped SQLite data needs no database rewrite.
- Named subagents are enabled by default. Pass `subagentProfiles: []` or set an empty `ZHIVEX_HARNESS_SUBAGENTS` value for a parent-only library run.
- Complete fingerprinted paused `0.4.x` runs with the `0.4.x` binary. They are not silently rebound to the new MCP, capability, approval, or child-policy contract.
- Keep MCP JSON configuration inside the canonical workspace and store only environment-variable names, never credential values.

### Security

- Network MCP calls always require durable interrupt approval, regardless of remote read-only annotations.
- MCP configuration rejects symlinks, workspace escapes, URL credentials, insecure non-loopback HTTP, unsafe headers, duplicate prefixes, and missing allowlists/permissions.
- MCP discovery and results fail closed on malformed schemas, prompt-injection directives, timeout, cancellation, and oversized output.
- Parallel review accepts only the read-only explorer/reviewer profiles; generic shell and `stdio` MCP remain unavailable until enforced execution environments.

## 0.4.0 - 2026-08-17 (private checkpoint)

### Added

- Scoped SQLite run and memory persistence as the default local operations store, including leases, compare-and-swap revisions, idempotency claims, and an exactly-once tool journal.
- `runs list`, `runs inspect`, `runs export`, `runs cancel`, and `runs cleanup` operator commands with schema-versioned JSON output.
- Step, wall-clock, tool-call, tool-error, input-token, output-token, total-token, and optional user-priced cost budgets.
- Deterministic bounded context compaction, production trace collection, redacted snapshots, traces, ledgers, and tool-journal inspection.
- A five-scenario golden evaluation gate covering analysis, edits and checks, denied approval, restart recovery, and provider portability.

### Changed

- Resolved configuration uses schema version `2`, includes an explicit durable scope, and defaults to the `sqlite` backend.
- Tool permissions, production safety policy, redaction, budget termination, durable memory, and harness/approval fingerprints are bound into every run.
- The installed-package smoke now proves SQLite restart recovery, exactly-once mutation journaling, redacted inspection, and the packaged golden baseline.

### Migration

- On first default local/workspace-scope open, legacy `0.3.x` file-backed runs are copied into the scoped backend and marked with `metadata.migratedFrom: "0.3-file-store"`; source files are retained for rollback. Custom scopes require intentional library migration.
- Use `--store file` or `ZHIVEX_HARNESS_STORE=file` only as a temporary compatibility path. New runs default to `<state-dir>/operations.sqlite`.
- Scope is part of durable identity. Use the same `--tenant`, `--user`, and `--namespace` values when listing, inspecting, exporting, cancelling, cleaning, or resuming a run.
- Resume rejects a mismatched workspace, provider/model, tool contract, approval policy, or harness fingerprint. Legacy paused runs receive the current binding only through the explicit resume path.
- Cost enforcement is enabled only when `--max-cost-usd` and input and/or output pricing are supplied; pricing is operator-provided and measured usage may cross the ceiling by one provider step.

### Security

- Operational exports omit raw messages, tool inputs/outputs, approval arguments, metadata, and full output text, and apply secret/email redaction.
- SQLite files are required to be regular non-symlink files and are created with owner-only permissions inside an owner-only state directory.
- Cleanup defaults to terminal states and requires an explicit cutoff; cancellation defaults to a cooperative request unless `--final` is supplied.

## 0.3.0 - 2026-08-16 (private checkpoint)

### Added

- Deterministic cursor pagination for file discovery and literal search, with SHA-256 content digests carried through inspection.
- Digest-bound multi-file proposals and conflict-safe patch application with mutation audit evidence.
- Approved file moves plus recoverable quarantine and restore operations; no permanent-delete model tool.
- Expanded read-only Git inspection for staged, unstaged, renamed, deleted, and untracked paths.
- A configurable explicit Bun package-script allowlist.
- Real Git repository fixtures covering inspect/edit/validate/diff, stale conflicts, rename, quarantine recovery, untracked files, failed checks, and final summaries.

### Changed

- Repository discovery respects Git and harness-specific ignore rules while keeping secret and state exclusions non-overridable.
- File replacement is published atomically, preserves existing modes, and rejects content changed after inspection.
- Repository-editing tools require reviewed content digests and emit before/after evidence.
- Upgraded `@zhivex-ai/meta` to `0.2.1`; Meta Chat streaming now preserves fragmented tool arguments and passed four consecutive proposal/approval/restart live gates.
- Live certification now exercises the contractual `propose_edits` then `apply_patch` sequence for every provider.
- The manual live-certification workflow defaults to the complete certified Meta, Qwen, and OpenAI matrix, with a documentation gate that rejects support-matrix drift.

### Migration

- Consume `nextCursor` until absent instead of treating a truncated list or search result as complete.
- Replace overwrite-oriented multi-file flows with `propose_edits` followed by approved `apply_patch` using the observed digest for every existing target and `null` for a target that must be new.
- Complete paused `0.2.x` approvals with the version that created them before upgrading; persisted approvals are not promised to migrate across tool-schema changes.
- Replace deletion workflows with `quarantine_file` and retain the returned identifier when later recovery may be required.

### Security

- Stale create/update/move/quarantine/restore requests fail before overwriting newer workspace content.
- Direct secret access, symlink escapes, special files, arbitrary host shell, Git writes, and permanent deletion remain unavailable.

## 0.2.0 - 2026-08-16

### Added

- Public package metadata and MIT licensing.
- A single runtime version source for the CLI and agent metadata.
- Versioned JSON output contracts and documented exit codes.
- A local `doctor` command that checks the runtime, workspace, Git, scripts, providers, and state directory without exposing credentials.
- Linux and macOS CI, installed-tarball smoke coverage, negative security regressions, and opt-in live-provider certification.

### Changed

- Package builds externalize declared dependencies instead of embedding the complete SDK in both entry points.
- New files are created with exclusive semantics to prevent concurrent non-overwrite calls from silently replacing one another.

### Migration

- `providers --json` now returns `{ schemaVersion: 1, kind: "providers", providers: [...] }` instead of a bare array.
- JSON run results now include `schemaVersion: 1` and `kind: "run-result"`.
- Invalid CLI usage exits with code `2`; a blocking `doctor` report exits with code `3`.
- State directories that target a workspace/filesystem root, protected workspace path, regular file, or symbolic link are rejected before the run store is created.

### Security

- Added regression coverage for protected state paths, special files, nested symlink escapes, concurrent creation, bounded output, timeout cleanup, and denied approvals.

## 0.1.0 - 2026-08-16

### Added

- Initial provider-portable coding harness MVP for Meta, Qwen, and OpenAI.
