# Published migration fixtures

Each published version has two immutable fixtures generated from the exact public npm tarball whose SHA-512 integrity is recorded in the JSON provenance:

- `<version>.sqlite` is the byte-for-byte SQLite database written by that published artifact, including terminal parent/child state, idempotency, tool journal and memory records, terminal session history, fork/archive metadata, and a paused approval with the original harness binding.
- `<version>.json` records the expected logical state, schema metadata, table definitions, and SHA-256 digest of the paired SQLite file.

Regenerate from the registry:

```bash
bun run scripts/generate-historical-migration-fixtures.ts
```

Or use already downloaded, integrity-verified files named `zhivex-harness-0.10.0.tgz` and `zhivex-harness-0.11.1.tgz`:

```bash
bun run scripts/generate-historical-migration-fixtures.ts --tarball-dir /path/to/tarballs
```

The generator executes only the published Harness `dist` against the repository's frozen dependency tree, never lifecycle scripts from the archive. Fixtures use the filesystem root as their workspace binding so the exact SQLite bytes remain portable across checkout paths. The verifier copies each historical SQLite file unchanged, checks its recorded digest and integrity, opens it through the current persistence and session APIs, and exercises reads, session fork/archive lineage, redaction, compatibility rejection, and backup safety. The JSON view normalizes the state path and random session/turn IDs; the SQLite file intentionally preserves the exact bytes emitted by the published artifact. The fixtures contain test markers, not production data. Checksums establish artifact integrity, not signer identity; npm provenance is verified separately by the release gate.
