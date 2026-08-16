# Changelog

All notable changes to Zhivex Harness are documented in this file.

The project follows Semantic Versioning. During `0.x`, minor releases may change user-facing contracts when the change is documented with a migration note. Patch releases remain backwards compatible bug fixes.

## 0.3.0 - Unreleased

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
