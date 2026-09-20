# HAR-HU-33 — Provider environment and SQLite boundary

Status: in progress; no acceptance criterion closed by this increment.

The stored provider key previously entered createHarness through its general env
option, which is also supplied to MCP discovery. Desktop now constructs the model
with a separate key-only environment and passes an empty general environment to
the Harness. The key remains outside the worker process environment and argv.
Desktop explicitly selects SQLite rather than allowing an ambient store override.

Before opening persistence, the runtime registers the known key in a process-private
protection set. SqliteDatabase checks SQL text and all bound values before invoking
SQLite. It checks literal and JSON-escaped values, named/numbered bindings and byte
buffers. Prepared statements are checked again at execution in case a key was
registered after preparation. Rejected writes throw only PERSISTENCE_SECRET_REJECTED;
there is no redacted substitution that could silently alter authoritative state.
Without registered values the existing CLI behavior is unchanged. No persisted
schema or stable public API changes are introduced.

Four focused tests (28 assertions) verify:

- Known-key rejection before SQL/positional/named/numbered/blob writes, with no
  secret bytes in the SQLite file or WAL and safe surrounding writes preserved.
- Previously registered keys remain protected after registering a new key.
- A statement prepared before registration is rejected when later executed.
- A simulated provider echo cannot enter durable run state; errors omit the key,
  a subsequent safe run completes, and every state file is scanned for key bytes.

The first full-suite attempt loaded the database module before an added prepared-
statement guard while discovering the new test later; it failed that one test.
The final suite is rerun against the unchanged final code. This is recorded rather
than treating the first run as passing.

## Limits and remaining acceptance

The guard rejects known literal/JSON-escaped credentials. It does not claim arbitrary
encoding detection, historical data scrubbing, or prevention of intentionally
encoded exfiltration. A rejected result remains a failed/recoverable operation,
not a successful output with modified content. Provider injection is confined to
model construction, but a native UI/Keychain-to-runtime journey still needs proof.
Keychain locked/invalid/rotation recovery through the packaged UI and complete
export/persistence-path coverage remain required before closing HU33. No personal
credentials, real provider calls, push, publication, signing or notarization used.

## Final verification

Final unchanged-tree suite: 707 pass, zero failures, 4081 assertions across 98 files.
Root/tooling/desktop types, contract and documentation checks passed. The unsigned
macOS package rebuilt successfully; its renderer passed all four geometry cases
(1120/720px, credential settings open/closed), preserving the preceding UX fix.
The packaged renderer check report is `/tmp/har-layout-Oa0ssw/report.json`.
The runtime staged increment produces identical Bun-minified output to the tested
working file while preserving external formatting outside the commit.
