# Anthropic direct API (provisional)

HAR-HU-41 adds `anthropic` through `@zhivex-ai/anthropic@0.12.4`. CLI and
Desktop use the same registry and curated catalogue. Set `ANTHROPIC_API_KEY` or
use the client's secure credential setup. Diagnostics expose presence and endpoint
validity only. `ANTHROPIC_BASE_URL` is optional and must be a trusted HTTPS API base including `/v1` (default `https://api.anthropic.com/v1`).
An unset, empty or whitespace-only endpoint uses that explicit default, without
inheriting another endpoint from the host process environment. The CLI does not
send a stored key to an overridden endpoint without setup consent.
OAuth, Vertex and Bedrock are separate routes and are not enabled by this integration.

```sh
zhx run --provider anthropic --model claude-sonnet-5 "Inspect this repository"
```

The default is an explicit catalogue choice, not a discovery or account-access
claim. Other curated choices are `claude-haiku-4-5` and `claude-opus-5-5`; an explicit
model ID can be supplied. IDs were checked against [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview)
on 2026-09-28. All entries remain unverified in Harness; limits/pricing remain
unknown until curated evidence is added. A missing/unavailable model is an error,
not an automatic fallback.

Harness reconstructs the SDK 0.12.4 thinking/signature SSE deltas into bounded signed blocks before durable history. Orphan, unsigned and oversized blocks fail closed.
The integration retains signed provider-specific continuation content, tool call IDs and
receipts, input/output usage, typed HTTP errors and abort signals. Contract tests
exercise both generation and streaming without live requests. Adding the route
with its default endpoint preserves the existing registry transport fingerprint;
changing its endpoint changes the binding and prevents stale durable resumes.

Anthropic remains **provisional** pending HAR-HU-45's installed-artifact live
certification. The [common task suite](https://github.com/Zhivex/zhivex-harness/blob/main/docs/TASK_ACCEPTANCE.md) is available for that
campaign; local mocks do not certify the provider. No new release is published by
this implementation.
