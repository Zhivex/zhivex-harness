# Documentation

Current interface policy: [Tauri and standalone web retirement](WEB_RETIREMENT.md).

## Use Harness

Start with [First use](FIRST_USE.md). You only need `zhx` for everyday conversations.

- [Daily console workflow](CLI.md#interactive-daily-workflow): editing, files, approvals and recovery.
- [Worked example](FIRST_USE_EXAMPLE.md): a small change with approval and restart recovery.
- [Usage reference](USAGE.md): scripts, providers and security boundaries.
- [Model catalog administration](MODEL_CATALOG.md): shared CLI/Desktop recommendations and remote distribution.
- [Anthropic direct API](ANTHROPIC.md): provisional setup and continuity contract.
- [Amazon Bedrock](BEDROCK.md): provisional Converse and OpenAI-compatible routes.
- [Azure OpenAI](AZURE_OPENAI.md): provisional endpoint, deployment, and API-key route.
- [Credentials](CREDENTIALS.md): system keychain, temporary keys and automation.
- [Project instructions and context](CONTEXT_ENGINEERING.md).
- [Project memory](PROJECT_MEMORY.md): explicit notes, retrieval budgets and deletion semantics.
- [Optional Web limits](WEB_LIMITS.md): interactive defaults and observed thresholds.
- [Execution environments](EXECUTION_ENVIRONMENTS.md): isolated command execution.
- [Desktop](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md): separate macOS alpha application.
- [Support](../SUPPORT.md), [support matrix](SUPPORT_MATRIX.md), [security policy](../SECURITY.md).

## Integrate Harness

- [Assistant Tauri workspace](ASSISTANT_TAURI_STAGE_2.md): native projects, scoped files and live coding activity.
- [Assistant Tauri review](ASSISTANT_TAURI_STAGE_3.md): approvals, exact changes, content-bound checks and checkpoint recovery.

- [Engine API and Code integration](ENGINE_API.md): terminal-independent imports and local candidate validation.
- [Code release procedure](CODE_RELEASE.md): independent RC publication, exact artifact, bootstrap provenance and Trusted Publishing.

- [CLI reference](CLI.md): command options, JSON/JSONL and exit codes.
- [Extensibility](EXTENSIBILITY.md): providers, MCP, routing and subagents.
- [API stability](STABILITY.md) and [deprecations](DEPRECATIONS.md).
- [Local service](LOCAL_SERVICE.md) and [client protocol](CLIENT_PROTOCOL.md), including the experimental [task evidence read](CLIENT_PROTOCOL.md#task-projection-v1-har-hu-73).
- [Code web tasks](CODE_WEB_TASKS.md): operator review and explicit snapshot acceptance before continuation.
- [Installed recovery laboratory](https://github.com/Zhivex/zhivex-harness/blob/main/docs/TASK_RECOVERY_LAB.md): contributor fixtures for the evidence read. The laboratory guide stays in the repository and is not part of the published package.
- [Experimental ACP text sessions](ACP.md) and [workspace checkpoint restoration](WORKSPACE_CHECKPOINTS.md).
- [Durable operations](DURABLE_OPERATIONS.md), [repository editing](REPOSITORY_EDITING.md) and [change envelopes](CHANGE_ENVELOPES.md).
- [Audit pack](AUDIT_PACK.md): experimental signed export of one run or guided task.
- [Threat model](THREAT_MODEL.md) and [public repository security](PUBLIC_SECURITY.md).

## Assistant

- [Tauri agent workspace plan](ASSISTANT_TAURI_AGENT_PLAN.md): staged coding journey, Code/Desktop reuse and acceptance gates.
- [MVP scope and phase status](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_MVP_PLAN.md) and [contracts](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_CONTRACTS.md).
- [Persistent host](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_HOST.md), [Telegram](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_TELEGRAM.md) and [Calendar](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_CALENDAR.md).
- [Automations](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_AUTOMATIONS.md), [extensions](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_EXTENSIONS.md) and [pilot acceptance](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_PILOT.md).
- [Web interface](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_WEB.md) and [first-day setup](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_FIRST_DAY.md).

- [Daily tools](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_DAILY_TOOLS.md), [Microsoft](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_MICROSOFT.md) and [proactive notices](https://github.com/Zhivex/zhivex-harness/blob/main/docs/ASSISTANT_PROACTIVE.md).

## Contribute and maintain

- [Harness/Code boundary proposal (ADR 0001)](https://github.com/Zhivex/zhivex-harness/blob/main/docs/adr/0001-harness-code-public-boundary.md): ownership, public APIs and the proposed 1.x transition.

[Contributor guide](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md) ·
[Maintenance and release evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/MAINTENANCE.md) ·
[Historical reports](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/README.md) ·
[Changelog](../CHANGELOG.md)

Primary guides are maintained in English. Historical reports preserve their original
language and evidence. Maintainer procedures and reports remain in the repository
and are excluded from the npm package. Published validation applies to the exact
release artifact, not automatically to later source changes.

- [Assistant native desktop preview](ASSISTANT_DESKTOP.md): Tauri build, lifecycle, verification and platform limits.
- [Assistant Tauri stage 4: terminal and persistent operation](ASSISTANT_TAURI_STAGE_4.md)
- [Assistant Tauri stage 5: isolated tasks and Git delivery](ASSISTANT_TAURI_STAGE_5.md)

- [Tauri stage 6: previews and browser evidence](ASSISTANT_TAURI_STAGE_6.md) — isolated static previews, approved browser checks and persistent artifacts.

- [Tauri stage 7: packaged local pilot](ASSISTANT_TAURI_STAGE_7.md) — installed checks, migration preflight and gradual cutover gates.
