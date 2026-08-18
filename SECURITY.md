# Security policy

## Supported versions

Security fixes are provided for the latest published `0.6.x` version. Pre-release source snapshots and older private checkpoints are not supported release channels.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/Zhivex/zhivex-harness/security/advisories/new) and include:

- the affected version and operating system;
- a minimal reproduction or proof of concept;
- the expected and observed security boundary;
- the practical impact; and
- any suggested mitigation.

Private vulnerability reporting must be enabled before the repository is made public. If that channel is unavailable, do not disclose exploit details in a public issue.

## Scope

Reports are in scope when they affect packaged runtime code, workspace or state isolation, approval enforcement, secret handling, MCP boundaries, provider communication, dependency integrity, or the build and release pipeline.

The absence of an OS sandbox is a documented product boundary rather than a vulnerability by itself. The harness does not expose generic host shell or permanent-delete model tools.
