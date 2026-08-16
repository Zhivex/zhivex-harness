# Live provider certification

The live provider smoke is an explicit release gate. It is not part of the deterministic unit-test suite because it makes billable upstream requests.

## What it proves

For each selected provider, the smoke:

1. starts a fresh process and asks the real model for one exact `write_file` call;
2. verifies that interrupt approval persists while the target file is still absent;
3. exits that process and starts a second process against the same file-backed run store;
4. approves and resumes the saved run;
5. verifies the completion token, one successful write result, one completed tool-journal entry, and the exact file contents.

The temporary workspace and state store are removed after each provider. Credential values are never written to output, prompts, fixtures, or results. Error output is redacted against every configured provider credential, custom endpoint, and Qwen workspace identifier before it is printed.

Success and failure evidence is emitted as JSON. A success record identifies the provider and model and records the approval, restart, tool-execution, and journal checks; it never contains a credential value. The complete default matrix continues after an individual provider failure, reports every provider result, and exits non-zero when any entry fails.

Meta supports only automatic tool choice. Qwen 3.8 thinking also cannot use named or required tool choice. Their gates therefore use automatic selection with an exact imperative prompt and fail unless `write_file` is selected. OpenAI uses named tool choice through Responses. This keeps Qwen's thinking budget available for the tool decision and avoids the OpenAI Chat streaming path, which currently loses a fragmented tool call when the final `tool_calls` finish chunk contains no tool delta.

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

Certification evidence is date-bound and account-bound. A local deterministic pass, installed-package pass, or one provider's live pass does not certify the other providers.

## 0.2.0 release-candidate evidence

Evidence collected on 2026-08-16 with the default models and the locally configured account:

The supported Qwen/OpenAI matrix passed again at `2026-08-16T19:47:49.773Z` after the final release-candidate changes.

| Provider | Model | Result | Evidence |
| --- | --- | --- | --- |
| Qwen | `qwen3.8-max` | Certified | Approval persisted, process restarted, one tool execution, and one completed journal entry. |
| OpenAI | `gpt-5.4` | Certified | Approval persisted, process restarted, one tool execution, and one completed journal entry through Responses. |
| Meta | `muse-spark-1.2` | Provisional | One isolated run completed the full path, but the complete-matrix rerun emitted an empty `{}` argument object for `write_file`; schema validation failed closed before any side effect. |

The supported `0.2.0` release matrix is therefore Qwen and OpenAI. Meta remains integrated but provisional until the automatic tool-call path passes repeatably. The failed Meta attempt did not write a file or consume an approval.
