# Documentation

Start with [First use](getting-started/FIRST_USE.md) for the terminal or the
[Assistant native guide](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_DESKTOP.md)
for the graphical application. Harness owns the engine, Code the terminal and
Assistant the Tauri interface. See the
[current interface policy](https://github.com/Zhivex/zhivex-harness/blob/main/docs/architecture/WEB_RETIREMENT.md).

Guides below are grouped by topic. Plans describe intended work; historical
reports preserve results and limitations from specific revisions, not current
certification. Repository-only documents use GitHub links so this index also works
inside the npm package.

## Getting started

- [First use](getting-started/FIRST_USE.md).
- [Worked example: approvals and recovery](getting-started/FIRST_USE_EXAMPLE.md).
- [Hostile repository demonstration](getting-started/HOSTILE_REPOSITORY_DEMO.md).
- [Usage reference](getting-started/USAGE.md).

## Assistant

- [Assistant — Automations and personal memory (phase 4)](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_AUTOMATIONS.md).
- [Assistant — Calendar (phase 3)](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_CALENDAR.md).
- [Assistant: contracts and Harness boundary](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_CONTRACTS.md).
- [Assistant: herramientas para el día a día](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_DAILY_TOOLS.md).
- [Assistant primary graphical interface (Tauri 2)](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_DESKTOP.md).
- [Assistant: configurable providers and composable modules](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_EXTENSIONS.md).
- [Assistant phase 1: profiles and persistent local host](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_HOST.md).
- [Microsoft 365 / Outlook in Assistant](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_MICROSOFT.md).
- [Assistant — validation and pilot preparation](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_PILOT.md).
- [Assistant: primera versión proactiva](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_PROACTIVE.md).
- [Assistant task metrics and initial evaluations](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_TASK_METRICS.md).
- [Tauri production preparation](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_TAURI_PRODUCTION.md).
- [Tauri stage 7: packaged local pilot and gradual cutover](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_TAURI_STAGE_7.md).
- [Assistant phase 2 — Telegram](https://github.com/Zhivex/zhivex-harness/blob/main/docs/assistant/ASSISTANT_TELEGRAM.md).

## Terminal

- [Opt-in auto-approve](cli/AUTO_APPROVE.md).
- [CLI reference](cli/CLI.md).
- [Console UX rationale](https://github.com/Zhivex/zhivex-harness/blob/main/docs/cli/CLI_UX.md).
- [Context engineering](cli/CONTEXT_ENGINEERING.md).
- [Project memory (experimental, RC candidate)](cli/PROJECT_MEMORY.md).
- [Reviewed workspace checkpoints](cli/WORKSPACE_CHECKPOINTS.md).

## Architecture and integration

- [Experimental ACP text sessions](architecture/ACP.md).
- [Source architecture](https://github.com/Zhivex/zhivex-harness/blob/main/docs/architecture/ARCHITECTURE.md).
- [Change envelopes](architecture/CHANGE_ENVELOPES.md).
- [Shared client protocol v1 (experimental)](architecture/CLIENT_PROTOCOL.md).
- [Durable operations](architecture/DURABLE_OPERATIONS.md).
- [Engine API and Code integration](architecture/ENGINE_API.md).
- [Enforced execution environments](architecture/EXECUTION_ENVIRONMENTS.md).
- [Extensibility and orchestration](architecture/EXTENSIBILITY.md).
- [Local runtime service and durable activity](architecture/LOCAL_SERVICE.md).
- [Isolated MCP stdio for trusted hosts](architecture/MCP_STDIO.md).
- [Minimum task authority (Experimental, unreleased)](architecture/MINIMUM_TASK_AUTHORITY.md).
- [Harness, terminal and Tauri](https://github.com/Zhivex/zhivex-harness/blob/main/docs/architecture/PRODUCT_CONSOLIDATION.md).
- [Trusted repository editing](architecture/REPOSITORY_EDITING.md).
- [Standalone web retirement](https://github.com/Zhivex/zhivex-harness/blob/main/docs/architecture/WEB_RETIREMENT.md).

## Providers and credentials

- [Anthropic direct API (provisional)](providers/ANTHROPIC.md).
- [Azure OpenAI (provisional)](providers/AZURE_OPENAI.md).
- [Amazon Bedrock (provisional)](providers/BEDROCK.md).
- [API keys](providers/CREDENTIALS.md).
- [Model catalog administration](providers/MODEL_CATALOG.md).
- [Google Cloud Vertex AI (provisional)](providers/VERTEX.md).

## Security

- [Audit pack](security/AUDIT_PACK.md).
- [Public repository security](security/PUBLIC_SECURITY.md).
- [RC14 delegated security decision](https://github.com/Zhivex/zhivex-harness/blob/main/docs/security/RC14_DELEGATED_SECURITY_DECISION.md).
- [Security review evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/security/SECURITY_REVIEW_EVIDENCE.md).
- [Threat model](security/THREAT_MODEL.md).
- [Trusted tool policy (experimental)](security/TOOL_POLICY.md).

## Maintenance and evaluation

- [Code release procedure](maintenance/CODE_RELEASE.md).
- [Competitive pilot protocol (HU51)](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/COMPETITIVE_PILOT.md).
- [Compatibility and deprecations](maintenance/DEPRECATIONS.md).
- [1.0 readiness](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/GA_READINESS.md).
- [Live provider certification](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/LIVE_CERTIFICATION.md).
- [Maintenance and release](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/MAINTENANCE.md).
- [Minimum offline evaluation preparation](maintenance/MINIMUM_OFFLINE_EVALS.md).
- [Release process](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/RELEASE.md).
- [Release rollback and recovery](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/ROLLBACK.md).
- [API stability](maintenance/STABILITY.md).
- [Support matrix for 1.0](maintenance/SUPPORT_MATRIX.md).
- [Support matrix for 1.1](maintenance/SUPPORT_MATRIX_1_1.md).
- [Common task acceptance](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/TASK_ACCEPTANCE.md).
- [HAR-HU-75: installed failure laboratory, phase one](https://github.com/Zhivex/zhivex-harness/blob/main/docs/maintenance/TASK_RECOVERY_LAB.md).
- [Time-to-Safe-Fix benchmark](maintenance/TIME_TO_SAFE_FIX.md).

## Plans

- [Assistant MVP by phase](https://github.com/Zhivex/zhivex-harness/blob/main/docs/plans/ASSISTANT_MVP_PLAN.md).
- [Tauri agent workspace implementation plan](https://github.com/Zhivex/zhivex-harness/blob/main/docs/plans/ASSISTANT_TAURI_AGENT_PLAN.md).
- [Gradual Code-to-Assistant migration](https://github.com/Zhivex/zhivex-harness/blob/main/docs/plans/CODE_TO_ASSISTANT_MIGRATION.md).

## Decisions and history

- [Architecture decisions](https://github.com/Zhivex/zhivex-harness/tree/main/docs/adr).
- [Historical report index](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/README.md).
- [Tauri implementation history, stages 0–6](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/ASSISTANT_TAURI_IMPLEMENTATION.md).
- [Retired Assistant web interface, onboarding and first session](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/ASSISTANT_WEB_HISTORY.md).
- [Former documentation paths](https://github.com/Zhivex/zhivex-harness/blob/main/docs/path-map.json).

[Contributing](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md) ·
[Support](../SUPPORT.md) · [Security policy](../SECURITY.md) · [Changelog](../CHANGELOG.md)

All repository documentation, including historical reports, is maintained in
English. Keep one authoritative guide per topic; add related sections there
instead of creating a new top-level document. Maintainer procedures, plans and
historical evidence stay in the repository and are excluded from the npm package.
