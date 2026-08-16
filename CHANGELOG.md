# Changelog

All notable changes to Zhivex Harness are documented in this file.

The project follows Semantic Versioning. During `0.x`, minor releases may change user-facing contracts when the change is documented with a migration note. Patch releases remain backwards compatible bug fixes.

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
