# Support

Zhivex Harness `0.5.x` is a pre-1.0 CLI and TypeScript library for Bun. Observable contracts may change in a later minor release when the change and migration path are documented in [CHANGELOG.md](./CHANGELOG.md).

## Supported baseline

- Bun `1.3.7` or newer;
- macOS and Linux, as exercised by CI;
- Git workspaces;
- the provider/model combinations marked certified in the package documentation; and
- HTTPS or explicitly allowed loopback-HTTP MCP endpoints using the documented bounded JSON-RPC subset.

Only the most recent published `0.5.x` patch receives routine fixes. Live provider evidence is account-, model-, endpoint-, and date-dependent; see [docs/LIVE_CERTIFICATION.md](./docs/LIVE_CERTIFICATION.md).

## Support channels

Use [GitHub Issues](https://github.com/Zhivex/zhivex-harness/issues) for reproducible bugs and feature requests. For vulnerabilities, follow [SECURITY.md](./SECURITY.md) and do not post exploit details publicly.

## Explicit limits

The harness does not promise arbitrary shell access, `stdio` MCP, permanent deletion, Windows support, a managed sandbox, a desktop UI, or exact feature parity between upstream providers. Tools run with the permissions of the local harness process unless an application supplies a stronger execution environment.
