# API stability

[`../contracts/public-api.json`](../contracts/public-api.json) is the machine-checked 1.0 baseline for the package root, binaries, CLI commands/subcommands, exit codes, and document schemas. Every runtime export is present in the snapshot. Exports listed as stable form the intended 1.x compatibility surface; Time-to-Safe-Fix exports are experimental; remaining root exports are beta until explicitly promoted before the final 1.0 freeze.

Stable means removal, incompatible signature/type change, semantic change, or stricter accepted input requires the next major release, except for a documented urgent security correction. Additive observational JSON fields are compatible. Digest-bound and signed-style documents use strict parsers: adding a field requires a new schema because unknown bytes change canonical identity.

The schema-1 observational parsers preserve unknown additive fields and distinguish rich `run-result` JSON from compact `run-stream-result` JSONL. Stable error documents intentionally exclude messages and causes; only `code`, `category`, and `retryable` are contractual. State-backup bundles are strict, checksummed, and workspace/scope-bound rather than observational.

Beta APIs may change in a minor with changelog and migration guidance. Experimental APIs may change without a deprecation window and must not be the sole supported route for a stable operation. Human-readable terminal text and error messages are not contracts; command identity, exit codes, structured document schemas, and `HarnessError.code/category/retryable` are.

Before `1.0.0-rc.1`, maintainers must decide whether each implicit-beta root export is promoted, moved to an explicit subpath, or removed. The snapshot intentionally rejects unreviewed additions and removals so that decision cannot happen accidentally.
