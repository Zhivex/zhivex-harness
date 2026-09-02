# Threat model

## Scope and assets

The protected assets are repository contents, credentials, durable run/session state, approval authority, exact change artifacts, release artifacts, and their audit evidence. Trust boundaries exist between the operator, model/provider, repository instructions, MCP servers, target subprocesses, the OCI runtime, local state, GitHub Actions, npm, and downstream consumers.

The machine-readable control map is [`../contracts/security-controls.json`](../contracts/security-controls.json). Every listed threat has test or documentation evidence plus an explicit residual risk.

## Actors and trust assumptions

- Repository content, `AGENTS.md`, project manifests, skills, model output, MCP responses, and subprocess output may be malicious.
- The operator grants approval deliberately after reviewing the complete governed payload.
- The local harness process, host filesystem permissions, kernel, OCI daemon, GitHub/npm identities, and configured provider endpoints are trusted infrastructure.
- Credentials are supplied outside repository content and are never intentionally returned by diagnostics or structured output.

## Security boundaries

Repository reads are bounded and no-follow. Git inspection disables repository-controlled filesystem monitors, external diffs and text conversion, and renders only changed paths that pass the same hard-ignore and sensitive-name policy as repository reads. Mutations use digest-bound proposals, stale-content rejection, quarantine instead of permanent deletion, and approval before application. Provider calls cannot create new application authority. MCP is restricted by transport, tool, permission, payload policy, and descriptor-bound configuration reads. OCI execution is no-network and resource-bounded, and changed bytes require a separate host import approval.

Durable state is scoped by workspace and tenant/user/namespace, uses optimistic revisions and leases, and does not permit incompatible paused approvals to be rebound. Release publication uses an annotated tag, one inspected tarball, checksum verification, protected live certification, npm OIDC, and SLSA provenance.

## Residual risk and exclusions

The `none` execution backend governs tools but does not isolate the host. Containers are not virtual machines. A compromised host, kernel, OCI daemon, provider account, package registry, source-control identity, or maintainer account is outside the protection the library can provide. Arbitrary model-generated prose may contain sensitive business data even after common-secret redaction. For hostile code, use a dedicated host or microVM and apply independent egress and identity controls.

## Review rule

A new trust boundary or authority-bearing tool requires a threat entry, a fail-closed mitigation, regression evidence, migration notes when durable fingerprints change, and live recertification when provider behavior is involved. Critical/high findings block a release candidate; residual risk must never be represented as eliminated when it is only transferred to infrastructure or the operator.
