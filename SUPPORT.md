# Support

Zhivex Harness `1.0.x` is the latest supported Node-first CLI and TypeScript library. Stable 1.x contracts follow [the stability policy](./docs/STABILITY.md); incompatible changes require a major release except documented urgent security corrections. Beta and experimental surfaces retain their declared policies. The mutable machine-readable public release state is recorded in the repository [release-status.json](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json), outside immutable npm artifacts.

The 1.0 support scope is tracked in the [machine-readable support matrix](./docs/support-matrix.json) and its [human-readable view](./docs/SUPPORT_MATRIX.md). Compatibility and removals follow [DEPRECATIONS.md](./docs/DEPRECATIONS.md) for the published 1.x line.

## Supported baseline

- Node.js `22.13.0` or newer; Node 24 LTS is the release and default OCI baseline;
- Bun `1.4.0` or newer when contributing to this repository or operating a Bun-managed target repository;
- macOS and Linux, as exercised by CI;
- Git workspaces;
- the provider/model combinations marked certified in the package documentation; and
- HTTPS or explicitly allowed loopback-HTTP MCP endpoints using the documented bounded JSON-RPC subset.

Only the most recent published `1.0.x` patch receives routine fixes. The exact `v1.0.0` tag passed protected release-bound base, orchestration, routing and model-directed execution for Meta, Qwen and OpenAI on 2026-09-20; the complete representative matrix passed on its authorized second attempt. Gemini remains provisional until its complete harness live matrix passes against an exact release candidate. Live provider evidence is account-, model-, endpoint-, artifact-, and date-dependent; see [docs/LIVE_CERTIFICATION.md](https://github.com/Zhivex/zhivex-harness/blob/main/docs/LIVE_CERTIFICATION.md).

## Installation diagnostics

Follow the [stable installation commands](./README.md#installation) or [isolated Bun example](./examples/README.md). Run `zhx --version`, `zhx --help`, and `zhx doctor` before reporting an installation issue. Doctor is local: a missing provider credential produces a diagnostic failure until that credential is configured. Include the version, OS, Node/Bun versions and sanitized diagnostics in a report; never include keys or your `.env` file.

## Support channels

Use [GitHub Issues](https://github.com/Zhivex/zhivex-harness/issues) for reproducible bugs and feature requests. For vulnerabilities, follow [SECURITY.md](./SECURITY.md) and do not post exploit details publicly.

## Explicit limits

The harness does not promise arbitrary shell access, `stdio` MCP, permanent deletion, Windows support, a managed sandbox, a desktop UI, or exact feature parity between upstream providers. Tools run with the permissions of the local harness process unless an application supplies a stronger execution environment.
