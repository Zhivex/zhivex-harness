# OpenAI terminal usage: isolated upstream proposal

This patch is a candidate for the SDK repository, not a Harness dependency patch.
It has not been applied to the concurrent SDK checkout, published, or enabled in
Harness. The installed 0.13.2 adapter continues to fail
`bun run scripts/validate-openai-stream-usage.ts`.

The patch defers rejection of a non-completed tool item until a terminal event
can supply validated numeric usage. No incomplete tool call is emitted. Missing
terminal events remain failures with unknown usage; payload fields are excluded.
Rejections during terminal tool materialization also retain available usage.
The original stream cancellation and timeout remain the caller's responsibility.

`evidence.json` records original and corrected source hashes and 17 passing
isolated regression tests across Core and OpenAI. Core exposes an optional,
validated and frozen numeric `usage` field on `ProviderToolCallError`. The test
files in the patch target the SDK's Vitest suite; equivalent tests ran with Bun
in the temporary copy. This is not evidence that the full SDK suite or published
dependency passes. A subsequent frozen SDK copy passed all 2078 tests, types,
build and docs with Bun 1.4.2, plus installed-consumer smokes. The only changed
declaration snapshot is Core `errors.d.ts`.

Harness budget handling has nine regressions for consuming this optional field
on the exact provider error, preserving the thrown error, rejecting invalid or
unrelated accounting and avoiding duplicate counting after a finish event. The
current installed adapter still cannot supply the field on this failing path.

Before shipping: run the SDK's required checks and API snapshots, review and
publish the corrected dependency, then update Harness to those published bytes. Preserve
fail-closed behavior when terminal usage is absent or invalid. Never infer
billable tokens from partial argument lengths, and do not retry unknown usage.

`installed-probe.mjs` ran with Node against local tarballs for Core, OpenAI and
Harness: exact 12 input/8 output tokens were preserved, no tool executed, and
the run still failed. The artifact hashes and exact local SDK commit are in
`evidence.json`. These are local candidates with unchanged package versions,
not npm releases. The patch applies to its frozen base; the concurrent SDK
checkout's already modified API snapshot needs integration before applying it.
