# Security policy

## Supported versions

Security fixes are provided for the latest published `0.8.x` version. The `0.9.x` source candidate and older private checkpoints are not supported release channels until their exact artifacts are published and verified.

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

`ChangeEnvelope v1` verifies canonical integrity, expiration, exact patch binding, and caller-supplied preconditions. It is not a signature or identity system; approval and external-attestation authenticity are explicitly reported as `not-verified`. A bypass in the documented built-in checks is in scope, while failure to validate an external trust bundle that the application never configured is outside that boundary.

The `0.9.x` workspace index caches topology only. File contents and content digests are reread through the stable anti-race path. Reports showing stale content returned as current, ignored files becoming discoverable after an ignore-policy change, or an accepted topology cursor after a structural mutation are in scope.

The `0.9.x` OCI backend may reuse one paused container inside an acquired run, but every command remains a separate publication transaction. Reports showing concurrent command execution, a failed/background command surviving into a later command, host-snapshot divergence not forcing reseed, `/tmp` state crossing a successful command boundary, or an unvalidated workspace reaching the durable snapshot are in scope.
