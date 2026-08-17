# Live provider certification

The live provider smoke is an explicit release gate. It is not part of the deterministic unit-test suite because it makes billable upstream requests.

## What it proves

For each selected provider, the smoke:

1. starts a fresh process and asks the real model to create one exact digest-bound proposal and apply that returned proposal;
2. verifies that interrupt approval persists while the target file is still absent;
3. exits that process and starts a second process against the same scoped SQLite run store;
4. approves and resumes the saved run;
5. verifies the completion token, one successful patch result, one completed tool-journal entry, and the exact file contents.

The temporary workspace and state store are removed after each provider. Credential values are never written to output, prompts, fixtures, or results. Error output is redacted against every configured provider credential, custom endpoint, and Qwen workspace identifier before it is printed.

Success and failure evidence is emitted as JSON. A success record identifies the provider and model and records the approval, restart, tool-execution, and journal checks; it never contains a credential value. The complete default matrix continues after an individual provider failure, reports every provider result, and exits non-zero when any entry fails.

Meta supports only automatic tool choice, and Qwen 3.8 thinking cannot use named or required tool choice. The complete matrix therefore uses automatic selection and an exact two-tool prompt: `propose_edits` must run first, and its returned `proposalId` must then be passed unchanged to `apply_patch`. Qwen and OpenAI run through Responses. Qwen Responses cannot accept `maxTokens`, so the harness enforces Qwen token budgets before and after each provider step without transporting that ceiling upstream; one step can cross the measured limit before the output guard observes it. Meta intentionally runs through Chat streaming to cover the fragmented tool-call assembler fixed in `@zhivex-ai/meta@0.2.1`.

## Run it

Keep provider credentials in the repository `.env`; Bun loads that file when the script starts. The gate refuses to make requests without the explicit opt-in variable:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
```

The default gate requires and tests Meta, Qwen, and OpenAI. To certify one provider while diagnosing an upstream or account issue:

```bash
ZHIVEX_HARNESS_LIVE=1 \
ZHIVEX_HARNESS_LIVE_PROVIDERS=qwen \
bun run scripts/live-provider-smoke.ts
```

Optional model overrides are:

- `ZHIVEX_HARNESS_LIVE_META_MODEL`
- `ZHIVEX_HARNESS_LIVE_QWEN_MODEL`
- `ZHIVEX_HARNESS_LIVE_OPENAI_MODEL`

Endpoint, Qwen workspace, and Qwen region overrides use the normal `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, and `OPENAI_BASE_URL` variables.

The separate `0.5.x` delegation matrix uses the same opt-in, provider selection, credentials, and model overrides:

```bash
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:orchestration
```

For every provider it requires exactly one `delegate_reviewer` call, verifies the bounded child response and aggregate token accounting, closes and reopens SQLite, and confirms the persisted parent/child link through the redacted hierarchical inspection. It does not make the legacy reviewed-edit smoke pass through delegation.

Certification evidence is date-bound and account-bound. A local deterministic pass, installed-package pass, or one provider's live pass does not certify the other providers.

Because `0.4.0` adds the production safety policy, harness binding, scoped SQLite persistence, required leases, budgets, and exactly-once journal recovery, `0.3.0` live evidence does not certify the new runtime path. The supported providers must pass the refreshed `apply_patch` approval/restart gate before the private milestone is considered complete.

## 0.4.0 private-milestone evidence

Evidence collected on 2026-08-17 with the default models and locally configured account. The complete matrix passed together at `2026-08-17T00:53:17.752Z` against the final scoped SQLite, fingerprint, and production-policy candidate.

| Provider | Model | Result | Evidence |
| --- | --- | --- | --- |
| Meta | `muse-spark-1.2` | Certified | Approval persisted in scoped SQLite, the process restarted, and exactly one patch execution and completed journal entry were observed. |
| Qwen | `qwen3.8-max` | Certified | Responses completed the proposal-first workflow with durable token enforcement, process restart, and exactly-once patch journaling. |
| OpenAI | `gpt-5.4` | Certified | Responses completed the proposal-first workflow with an upstream-compatible output ceiling, process restart, and exactly-once patch journaling. |

This evidence certifies provider interaction for the private `0.4.0` candidate only. It does not prove registry publication, provenance, or availability of a public artifact.

## 0.5.0 orchestration status

The `0.4.0` matrix remains valid evidence for the shared proposal, approval, SQLite restart, and exactly-once patch path, but it does not certify model-directed delegation or provider behavior with the expanded MCP/subagent tool surface.

`0.5.0` has deterministic evidence for capability rejection, MCP discovery/approval/resume, prompt-injection and output bounds, durable child approval promotion, exactly-once child mutation, cancellation propagation, scoped hierarchical inspection, aggregate budgets, and application-owned parallel review.

The complete delegation matrix passed at `2026-08-17T02:21:45.553Z`. Each provider made exactly one model-directed `delegate_reviewer` call, completed the bounded child, accounted for aggregate tokens, persisted parent and child, reopened SQLite, and exposed a redacted two-run hierarchy.

| Provider | Model | Result | Evidence |
| --- | --- | --- | --- |
| Meta | `muse-spark-1.2` | Certified | One reviewer delegation completed; parent and child survived reopen with a two-run hierarchy and aggregate usage. |
| Qwen | `qwen3.8-max` | Certified | Responses parent delegation and generated child output completed; persistence, hierarchy, and aggregate usage passed. |
| OpenAI | `gpt-5.4` | Certified | Responses parent delegation and generated child output completed; persistence, hierarchy, and aggregate usage passed. |

This certifies the bounded reviewer-delegation path, not arbitrary task quality or every subagent profile.

The separate controlled MCP interoperability gate passed at `2026-08-17T13:05:05.542Z` against a real loopback Streamable HTTP server. It exercised protocol `2025-06-18`, authorization and protocol headers, session negotiation, `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, JSON and SSE responses, schema-backed discovery, bounded output, and the forced interrupt-approval policy for network tools. Run it with:

```bash
bun run smoke:mcp
```

This is stronger than an injected `fetch` fixture because it uses the operating system network stack and a running server. It certifies the harness transport contract against the controlled implementation; it does not claim compatibility with every third-party MCP server or unsupported `stdio` transport.

## 0.3.0 private-milestone evidence

Evidence collected on 2026-08-16 with the default models and locally configured account. After aligning the gate with the required proposal-first workflow, Qwen and OpenAI passed together at `2026-08-16T23:37:23.791Z`. After upgrading to `@zhivex-ai/meta@0.2.1`, Meta passed four consecutive runs from `2026-08-16T23:32:50.716Z` through `2026-08-16T23:33:27.161Z`.

| Provider | Model | Result | Evidence |
| --- | --- | --- | --- |
| Qwen | `qwen3.8-max` | Certified | Digest-bound patch approval persisted, the process restarted, and exactly one patch execution and completed journal entry were observed. |
| OpenAI | `gpt-5.4` | Certified | Digest-bound patch approval persisted through Responses, the process restarted, and exactly one patch execution and completed journal entry were observed. |
| Meta | `muse-spark-1.2` | Certified | Four consecutive proposal-first runs produced complete tool arguments, persisted approval, restarted the process, and observed exactly one patch execution and completed journal entry. |

The supported `0.3.0` live matrix is Meta, Qwen, and OpenAI. Earlier Meta failures remain relevant historical evidence: `@zhivex-ai/meta@0.2.0` split one streamed Chat tool call across `id` and `index` buffers, while a direct-apply smoke prompt could also be rejected because it skipped `propose_edits`. The adapter and gate now cover those separate failures.

## 0.2.0 release-candidate evidence

Evidence collected on 2026-08-16 with the default models and the locally configured account:

The supported Qwen/OpenAI matrix passed again at `2026-08-16T19:47:49.773Z` after the final release-candidate changes.

| Provider | Model | Result | Evidence |
| --- | --- | --- | --- |
| Qwen | `qwen3.8-max` | Certified | Approval persisted, process restarted, one tool execution, and one completed journal entry. |
| OpenAI | `gpt-5.4` | Certified | Approval persisted, process restarted, one tool execution, and one completed journal entry through Responses. |
| Meta | `muse-spark-1.2` | Provisional | One isolated run completed the full path, but the complete-matrix rerun emitted an empty `{}` argument object for `write_file`; schema validation failed closed before any side effect. |

The supported `0.2.0` release matrix is therefore Qwen and OpenAI. Meta remains integrated but provisional until the automatic tool-call path passes repeatably. The failed Meta attempt did not write a file or consume an approval.
