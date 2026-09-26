# RC3: runtime-owned edit references

RC2 (`5be1688cd25175617dea3cbc01b1d8ef417da7ea`,
[run 36210544559](https://github.com/Zhivex/zhivex-harness/actions/runs/36210544559))
passed deterministic artifact validation and live certification, then failed the
representative matrix. Publication was skipped. Meta passed 14/14; Qwen passed
12/14; the OpenAI representative stage did not run.

The failed Qwen cases were Python with `TEST_DELETE` (`EXECUTION_FAILED`) and the
clean package-manager fixture (`EXECUTION_FAILED` with `SyntaxError`). Both had
zero unauthorized effects. These diagnostics do not establish a patch-ID
mismatch, and the syntax error does not identify whether tool JSON or the stream
frame was malformed. RC3 does not relabel either failure as success.

## Contract change

`runHarness` presents simplified schemas for reviewed replacement/full-file edits
and OCI imports. A model supplies paths, changes and verifier argv. The runtime
fills omitted file digests from successful preceding read receipts and omitted
patch IDs from the preceding successful inspection receipt, before SDK preflight,
approval binding, checkpointing and execution.

Existing approval and programmatic schemas remain unchanged. Explicit legacy
references are never overwritten. A missing read or inspection stays invalid;
compaction may require another read. New files require explicit `create: true`.
The runtime does not inspect a newer file or patch while resuming an approval.
Availability restrictions remain authoritative, including caller-supplied tool
schemas. Files and snapshots changed since review still fail closed.

This follows the model-facing separation used by
[Codex apply_patch](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/runtimes/apply_patch.rs),
[Claude Code Edit](https://code.claude.com/docs/en/tools-reference#edit-tool-behavior)
and [Gemini CLI edit](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/edit.ts):
models describe edits while the application owns validation and permission.
It does not assert that their persistence or OCI guarantees are identical.

## Recovery and release gates

CLI and representative runs return sanitized schema-validation receipts under
existing step/error budgets. Approval and execution failures remain authoritative.
Provider syntax errors receive a separate diagnostic label, with no raw payload,
no implicit retry and no inferred token accounting. Patch inspection is now a
named diagnostic operation instead of `other_tool`.

RC3 keeps the same Meta `muse-spark-1.3`, Qwen `qwen3.8-flash` and OpenAI
`gpt-6-luna` cohort, all 42 representative cases and exact-tarball live gates.
Passing deterministic regressions does not certify Qwen or authorize a failed
candidate to publish. The protected workflow must certify RC3's own bytes before
publication and provenance verification. RC1 and RC2 tags remain immutable.
