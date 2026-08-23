# Live provider certification

Live certification is an explicit release gate because it makes billable upstream requests. It is separate from deterministic tests, installed-artifact validation, and registry publication.

## What it proves

For each selected provider, the base gate:

1. creates one digest-bound proposal with a real model;
2. pauses before the mutation and persists the approval request;
3. restarts against the same scoped durable store;
4. approves and resumes the saved run; and
5. verifies exact completion, patch contents, and exactly-once journal evidence.

Separate gates exercise reviewer delegation, mixed-provider routing, model-directed OCI execution, and the real container boundary. Passing one gate never implies that another provider or execution path is certified.

The default mixed-provider route uses OpenAI as parent and Qwen as reviewer, keeping the release gate inside the certified cohort. Set `ZHIVEX_HARNESS_LIVE_PARENT_PROVIDER` and `ZHIVEX_HARNESS_LIVE_REVIEWER_PROVIDER` explicitly to certify another pair; selecting Gemini remains provisional and requires its credential plus every provider gate.

## Running the gates

The package exposes dedicated Bun scripts for:

- the base provider approval/restart matrix;
- bounded reviewer delegation and persistence;
- mixed-provider parent/child routing;
- model-directed command, review, and import; and
- real OCI boundary enforcement.

Live scripts require an explicit network opt-in and explicit local credentials. Provider selection and model or endpoint overrides use the normal configuration contract. The scripts fail closed when prerequisites are missing and print the required invocation without revealing configured values.

Keep credentials and account-specific configuration only in the ignored local environment file. Never commit that file or copy its contents into prompts, fixtures, evidence, or issue reports.

## Support labels

The default live matrix contains only providers marked `certified` by the registry. A provisional provider must be selected explicitly and remains provisional until all required provider, delegation, routing, and execution gates pass for the release candidate.

Gemini is integrated as a provisional provider in `0.7.0`. Deterministic adapter tests or independent SDK certification are insufficient to promote it.

## Evidence contract

Certification evidence is provider-, model-, endpoint-, account-, artifact-, and date-bound. A valid record contains only:

- provider and model identifiers;
- pass/fail status for each required boundary;
- approval, restart, persistence, journal, routing, and execution checks;
- the source commit and exact artifact identity; and
- a timestamp suitable for determining staleness.

Evidence must not contain credential values, custom endpoints, workspace or account identifiers, raw prompts, tool arguments, provider payloads, durable messages, stack traces, or repository contents. Operator-specific evidence belongs in protected CI artifacts with bounded retention; public documentation records only the support conclusion and its limits.

## Redaction and failure behavior

Credential values and account-specific configuration are redacted from text and structured errors before output. The complete matrix continues after an individual provider failure, reports a bounded result for every selected provider, and exits non-zero when any required entry fails.

A missing credential, unavailable container runtime, upstream failure, incomplete tool sequence, routing mismatch, stale artifact, or redaction failure leaves the affected path uncertified. Deterministic tests, successful package installation, or credential presence are never substitutes for live evidence.

## Current public status

`@zhivex-ai/harness@0.11.0` is published as `latest` with an annotated tag, verified registry integrity, and SLSA provenance. Those supply-chain facts do not certify provider behavior. The protected remote live workflow attempted the `0.11.0` candidate but stopped before provider calls because its GitHub environment contained no provider credentials; publication therefore has no successful release-bound remote provider matrix.

The release workflow now fails closed on the base, orchestration, routing, and model-directed execution gates before npm publication. The protected `live-certification` environment must receive maintainer-approved provider secrets before the next release. Local `.env` credentials are never uploaded automatically.

The controlled and official-SDK MCP interoperability gates remain separate transport evidence. They certify only the tested protocol, implementation, and compatibility mode, not every MCP server or future protocol version.

## Current local tag-source evidence

On 2026-08-22, a clean checkout of annotated tag `v0.11.0` at `652a299e2d6997ca4001dd9931ef2a82645f7204` passed the base proposal/approval/restart/exactly-once matrix for Meta `muse-spark-1.2`, Qwen `qwen3.8-max`, and OpenAI `gpt-5.6-luna`. The same checkout passed bounded reviewer delegation and persistence for all three providers plus the OpenAI-parent/Qwen-reviewer mixed route.

This evidence is source/tag-bound and date-bound, not a successful protected GitHub run or an installed-artifact provider certification. Model-directed OCI execution was not rerun locally because no Docker daemon was available; deterministic OCI enforcement passed on the exact published commit in CI. Gemini remains provisional.

## Current security-hardening worktree evidence

On 2026-08-23 UTC, the pre-commit security-hardening worktree passed the complete local live matrix for Meta `muse-spark-1.2`, Qwen `qwen3.8-max`, and OpenAI `gpt-5.6-luna`: proposal/approval/restart/exactly-once, bounded reviewer delegation with SQLite reopen, OpenAI-parent/Qwen-reviewer routing, and model-directed command/review/separate-import execution against the pinned OCI image. This confirms the changed worktree behavior only; it is not tag-, installed-artifact-, protected-environment-, registry-, or provenance-bound evidence.

The same worktree passed Gemini `gemini-3.7-flash` proposal/approval/restart/exactly-once and bounded reviewer delegation after the create-only digest field was made explicitly required in the tool schema and certification prompt. Its model-directed OCI execution did not complete: the two bounded attempts stopped on provider HTTP `429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE` before a successful execution sequence. Gemini therefore remains provisional until execution and any required routing gates pass against an exact release candidate.

## Historical local pre-release evidence

On 2026-08-20, the uncommitted `0.8.0` source worktree with `@zhivex-ai/core@1.7.0` and `@zhivex-ai/openai@0.9.6` passed the base proposal/approval/restart/exactly-once gate for the GPT-5.6 family used by the Harness:

| Provider | Model | Result |
| --- | --- | --- |
| OpenAI | `gpt-5.6-luna` | Passed |
| OpenAI | `gpt-5.6-terra` | Passed |
| OpenAI | `gpt-5.6-sol` | Passed |

Every run persisted the `apply_patch` approval, restarted against the same scoped durable store, executed the approved mutation exactly once, and recorded exactly one completed journal entry.

The `0.8.0`-bound runs completed at `2026-08-20T20:13:24.151Z` for Luna, `2026-08-20T20:13:25.211Z` for Terra, and `2026-08-20T20:13:27.441Z` for Sol. The Luna run omitted the model override and resolved to `gpt-5.6-luna` through the provider registry default.

This is local pre-release evidence, not public release certification: the worktree is not committed, the exact `0.8.0` artifact is not published, and the source-commit/provenance requirement is therefore unsatisfied. It certifies only the shared Harness edit-and-resume path. It does not certify GPT-5.6 Programmatic Tool Calling, Multi-agent, hosted tools, long-context pricing, model-directed OCI execution, or mixed-provider routing.
