# Documentation

Start with the [project README](../README.md) for stable 1.0 installation and a first run, or the [isolated Bun installation example](../examples/README.md). These guides describe the source checkout; published certification applies only to the exact artifacts recorded in the release evidence.

## Usage and integration

- [Guided first use](FIRST_USE.md): clean profile, example, approvals and recovery.
- [Local service](LOCAL_SERVICE.md): protected Unix transport, durable replay and coordinated cancellation.
- [Shared client protocol](CLIENT_PROTOCOL.md): experimental commands, revisions, exact approvals and reference client.
- [CLI](CLI.md): commands, interactive sessions, configuration and output contracts.
- [Repository editing](REPOSITORY_EDITING.md): proposals, approvals, moves and recovery.
- [Durable operations](DURABLE_OPERATIONS.md): persistence, budgets, resumption and migrations.
- [Context engineering](CONTEXT_ENGINEERING.md): instructions, task memory and compaction.
- [Extensibility](EXTENSIBILITY.md): providers, MCP, routing and subagents.
- [Execution environments](EXECUTION_ENVIRONMENTS.md): OCI configuration and isolation.
- [Change envelopes](CHANGE_ENVELOPES.md): portable change evidence and verification.
- [Hostile repository demo](HOSTILE_REPOSITORY_DEMO.md): runnable boundary demonstration.

## Contracts and security

- [API stability](STABILITY.md), [support matrix](SUPPORT_MATRIX.md) and [deprecations](DEPRECATIONS.md).
- [Threat model](THREAT_MODEL.md) and [public repository security](PUBLIC_SECURITY.md).
- [Security policy](../SECURITY.md) and [support policy](../SUPPORT.md).
- [Gemini 1.0 decision](GEMINI_1_0_DECISION.md): dated support decision and promotion requirements.

## Maintenance and release

- [Contributing](https://github.com/Zhivex/zhivex-harness/blob/main/CONTRIBUTING.md), [roadmap](../ROADMAP.md) and [changelog](../CHANGELOG.md).
- [Release procedure](RELEASE.md) and [rollback](ROLLBACK.md).
- [Live certification](LIVE_CERTIFICATION.md): artifact-bound provider evidence.
- [GA readiness](GA_READINESS.md), [security review requirements](SECURITY_REVIEW_EVIDENCE.md).

## Evaluation and historical reports

Detailed development reports and benchmark baselines live in the repository
archive and are excluded from the installed package. Results remain available,
including failed attempts; the guides below describe their scope.

- [RC.13 reviewer dossier](RC13_SECURITY_REVIEW.md) and [RC.14 reviewer dossier](RC14_SECURITY_REVIEW.md): prerelease assessments retained as history.

- [Benchmark guide](../benchmarks/README.md) and [Time-to-Safe-Fix protocol](TIME_TO_SAFE_FIX.md).
- [Report index](https://github.com/Zhivex/zhivex-harness/blob/main/docs/reports/README.md): dated audits, remediation evidence and model comparisons. Historical findings and scores do not describe later code automatically.

- [Desktop architecture spike](DESKTOP_ARCHITECTURE.md): Electron/React process boundaries and unsigned macOS packaging evidence.
