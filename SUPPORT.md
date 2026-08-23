# Support

Zhivex Harness `0.11.x` is the latest supported pre-1.0 Node-first CLI and TypeScript library. Observable contracts may change in a later minor release when the change and migration path are documented in [CHANGELOG.md](./CHANGELOG.md). The mutable machine-readable public release state is recorded in the repository [release-status.json](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json), outside immutable npm artifacts.

The detailed 1.0 target is tracked in the [machine-readable support matrix](./docs/support-matrix.json) and its [human-readable view](./docs/SUPPORT_MATRIX.md). Compatibility and removals follow [DEPRECATIONS.md](./docs/DEPRECATIONS.md) once 1.0 is promoted.

## Supported baseline

- Node.js `22.13.0` or newer; Node 24 LTS is the release and default OCI baseline;
- Bun `1.4.0` or newer when contributing to this repository or operating a Bun-managed target repository;
- macOS and Linux, as exercised by CI;
- Git workspaces;
- the provider/model combinations marked certified in the package documentation; and
- HTTPS or explicitly allowed loopback-HTTP MCP endpoints using the documented bounded JSON-RPC subset.

Only the most recent published `0.11.x` patch receives routine fixes. The exact `v0.11.1` tag passed the protected release-bound base, orchestration, routing, and model-directed execution matrix for Meta, Qwen, and OpenAI on 2026-08-23. Gemini remains provisional until its complete harness live matrix passes against an exact release candidate. Live provider evidence is account-, model-, endpoint-, artifact-, and date-dependent; see [docs/LIVE_CERTIFICATION.md](./docs/LIVE_CERTIFICATION.md).

## Support channels

Use [GitHub Issues](https://github.com/Zhivex/zhivex-harness/issues) for reproducible bugs and feature requests. For vulnerabilities, follow [SECURITY.md](./SECURITY.md) and do not post exploit details publicly.

## Explicit limits

The harness does not promise arbitrary shell access, `stdio` MCP, permanent deletion, Windows support, a managed sandbox, a desktop UI, or exact feature parity between upstream providers. Tools run with the permissions of the local harness process unless an application supplies a stronger execution environment.
