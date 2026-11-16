# Core workspace

`src/` owns the shared application, persistence, execution and protocol code. Electron and the CLI consume the same installed `@zhivex-ai/harness` artifact.

The root manifest remains the publishing adapter for existing package exports and binaries. This workspace is private; its version and engines mirror the root. Run `bun run workspace:check` from the repository root to validate the layout, or `bun run --cwd packages/core typecheck` to validate the core.

See [application migration](../../docs/APPLICATION_MIGRATION.md) for data preservation and distribution gates.
