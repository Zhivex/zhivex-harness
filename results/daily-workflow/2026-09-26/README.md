# Installed assistant validation

## Latest unified-runtime campaign

Runtime source: `4073d8d`. This artifact removes the `strict`/`repair` choice and uses
`requireVerifiedDelivery` as an independent option. It includes v7 user-steering
retention, adaptive protected-tail sizing and the revised output budget policy.

- Artifact SHA-512: `aaff87a9ac453516d4a498c84055ffb5e811de84c3d10f87fadcb699fab9d2101e7bbd8bdbe063a9b5cc4ea6e7fa0f428362c3859e72e2d476d24214bba2f4a1`.
- Installed module SHA-256: `23c969852009be4ed9b6080e371b207570b57c117bec4d290d32ff9f2b8c35c9`.
- Continuity: **18/18 turns passed**, with 18 actual compactions and 15 process restarts. See `continuity-final.json` and its three provider reports.
- Coding: **4/6 cases passed**. OpenAI passed both tasks; Meta and Qwen passed the two-file feature. Meta's rounding run failed with HTTP 400 / `previous_response_unavailable`; Qwen's rounding run was cancelled at 150 seconds without an edit. Independent rounding tests remained failing. No reattempts were made in this campaign.
- Approval plus restart: **3/3 providers passed**. OCI execution plus verified host import: **3/3 passed**. Delegation: **2/3 passed**; Qwen encountered a delegation-contract argument violation before SDK recovery. That result is preserved in `smoke-orchestration-final.json`.

Coding used the product's configured token defaults: 100,000 input, 30,000 output,
120,000 total. The acceptance limits remained 12 steps and 150 seconds; this is not
the product's full default timeout. Continuity used 24,000 input and 8,192 output /
generation tokens per turn. Earlier campaigns used different limits, so their pass
rates are not a controlled before/after performance comparison. Reports include
actual usage and retain incomplete work as failed, even if its file effects passed.

Subsequent review-only JSON parser and delegation-recovery changes are tracked
separately from this immutable installed artifact. These results are not certification
of an npm release or of any other artifact with the same version string.

The final targeted delegation artifact uses module SHA-256
`576ee23f5e893992673ac73643a87ce53978127d33c941f1179691a474f842ee`
and tarball SHA-512
`14b7f7df753c85899339a4b559d8a5d50faf8f2b01211a74f1c600e5f783d10d833a9a91165e72a28c44363ef6deef63d41c7dd325e6435521831a67e9cf60b2`.
It returns malformed public delegation inputs through bounded SDK validation,
without creating a child, and preserves hidden-tool rejection. The separate
Qwen observation passed in `smoke-orchestration-qwen-recovery.json`; no initial failure
was overwritten and no other provider was rerun for this narrowly scoped fix.
Deterministic regressions exercise invalid-then-corrected arguments explicitly;
the live smoke proves successful delegation but does not prove that the model
needed the recovery branch on this attempt.

## Earlier artifacts and retained failures

Runtime source: `1141505` on `feat/reliable-agent-loop`, based on `main` at `5b2f846`. The package was built, packed with Bun and installed into a separate temporary consumer. SDK/provider dependencies were unchanged. Gemini is excluded from this campaign at the user's request.

Artifact SHA-512: `417fa626b19bbba55bdcec257b02ec75654fe58c4fca3dbfe471e22bddecc710278ae16ebf73a3a0df1e8327933dc081e448d63aae589e9ad0b9335f3a78a867`.

Installed entry module SHA-256: `e751af235ca6e8609be43ddcaf87c40954b7940f982ee704baeaacba33b69fea`.

These are local acceptance observations, not protected release certification or a competitive benchmark. The scripts and reports are separate from the tested runtime. The package retains version `1.2.0-rc.4`; this does not certify the previously prepared release candidate or publish new bytes under that version.

## Coding tasks

Two disposable repositories per provider exercise a decimal-rounding repair and a two-file cart feature. Independent Bun tests fail before the task and must pass afterward. Tests and package configuration must remain unchanged. Approval is restricted to implementation paths and the declared test command.

The initial network-enabled matrix passed **2/6** cases:

| Provider / model | Rounding | Two-file feature |
| --- | --- | --- |
| Meta / muse-spark-1.3 | Failed to complete | Passed |
| Qwen / qwen3.8-max | Failed to complete | Failed to complete |
| OpenAI / gpt-6-luna | Failed to complete | Passed |

Limits were 12 steps, 150 seconds, 60,000 input tokens, 4,096 output tokens and 64,096 total tokens per case. These are evaluation limits, not the runtime's full default budget. The initial driver did not preserve failed run status/usage, so the precise cause of each initial incomplete run cannot be established from those reports. They remain included unchanged.

The diagnostic driver now records effective budgets, run status, token consumption, tool/check outcomes and independent post-run tests even when the run fails. A separately recorded OpenAI rounding attempt passed with the same limits, including failing check, approved replacement and successful check. This does not erase or explain its initial failure.

Initial sandbox DNS failures happened before useful provider calls and are excluded from the live matrix. Their local diagnostic files are retained under `release-artifacts/assistant-live-2026-09-26/`; they are not counted as model failures or successful runs.

## Conversation continuity

The initial three-turn campaign forced deterministic compaction and restarted the process between completed runs. OpenAI passed all three turns. Qwen's test request used an unsupported combination of Responses mode and `maxTokens`; the final driver uses its supported chat mode. Meta's last response hit the 1,024-token cap and failed the JSON/recall assertions. The initial report is preserved in `continuity-initial.json`.

The extended scenario changes objectives over six turns, corrects an earlier fact, retains compatibility and rejected-approach constraints, and reloads the durable conversation between processes. This checks repeated compaction and restart mechanics; it is not a natural hours-long programming session or semantic-compactor evaluation.

The six-turn initial campaign passed 9/18 turns. Some responses were truncated; other
valid responses selected the old fact despite a correction. The v7 aligned artifact
(`40b52da40f40894d48ab8baeb0d3ff7cc70183beb48c6d62a17eeb125402c01f`) passed
18/18 with the explicit larger output allowance. Its same-limit coding campaign
completed 3/6 cases, plus one Qwen case whose implementation/tests passed but whose
run exhausted its budget. All original reports remain unchanged beside this summary.

## Reproduction

Build, pack and install a fresh candidate with Bun. Keep each report under a new path; both scripts are explicitly opted in and make paid requests.

```sh
ZHIVEX_HARNESS_LIVE=1 ZHIVEX_HARNESS_LIVE_PROVIDERS=meta,qwen,openai \
  bun --env-file=.env run scripts/daily-workflow-live-smoke.ts \
  /absolute/consumer/node_modules/@zhivex-ai/harness/dist/index.js \
  /absolute/coding-report.json

ZHIVEX_HARNESS_LIVE=1 ZHIVEX_HARNESS_LIVE_PROVIDERS=meta,qwen,openai \
  RELEASE_TAG=v1.2.0-rc.4 \
  ZHIVEX_HARNESS_LIVE_RUNTIME=/absolute/consumer/node_modules/@zhivex-ai/harness/dist/index.js \
  bun --env-file=.env run scripts/live-continuity-smoke.ts /absolute/continuity-report.json
```

The continuity loader requires a matching version tag as an input check; setting it does not create a Git tag, publish, or confer release certification. Provider model overrides use `ZHIVEX_HARNESS_LIVE_<PROVIDER>_MODEL`.

To use the configured product token defaults for coding, set
`ZHIVEX_HARNESS_LIVE_DAILY_BUDGET=runtime-token-defaults`. The default script mode
remains `bounded-baseline`; the selected mode and effective budgets are recorded.
