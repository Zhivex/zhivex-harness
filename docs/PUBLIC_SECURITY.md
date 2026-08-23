# Public repository security

This document records which GitHub-hosted security controls the project uses, their cost boundary, and the controls that remain intentionally disabled. Recheck the pricing and repository visibility before changing this configuration.

## Enabled no-cost controls

The repository is public. GitHub documents the following controls as available without a paid GitHub Secret Protection or GitHub Code Security license for public repositories:

- private vulnerability reporting;
- secret scanning alerts for supported provider patterns;
- repository push protection;
- Dependabot alerts and security updates;
- CodeQL code scanning on standard GitHub-hosted runners; and
- standard GitHub-hosted Actions runners.

The repository additionally uses a `main` ruleset with pull-request review, review-thread resolution, linear history, and required CI checks. Repository Actions default to read-only permissions; individual jobs must request any narrower write capability explicitly. The npm publication job is the only workflow path that requests `id-token: write`, and it uses the protected `npm` environment.

References:

- [GitHub security features](https://docs.github.com/en/code-security/getting-started/github-security-features)
- [Secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning)
- [Dependabot security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates)
- [CodeQL CLI and public repositories](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-cli)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)

## Cost-gated controls left disabled

The project does not enable larger GitHub-hosted runners, custom runner images, or private-repository GitHub Secret Protection/GitHub Code Security licenses. Those paths can incur GitHub charges and require explicit maintainer approval.

Generic or AI-detected secret patterns, non-provider patterns, and secret validity checks remain disabled until their entitlement and billing behavior are confirmed for the owning organization. Standard provider-pattern secret scanning and repository push protection remain enabled.

If the repository becomes private or internal, treat every security feature and Actions runner as cost-unknown until GitHub billing is rechecked. Do not silently preserve the public-repository assumptions in this document.

## Operational exception: live provider certification

The `live-certification` GitHub environment is the only workflow scope authorized to hold provider credentials. Whether credentials are currently configured is mutable repository state and is intentionally not asserted by this document; maintainers must verify it at dispatch time. Adding or rotating credentials transfers sensitive provider keys into GitHub and requires an explicit maintainer decision.

The release workflow fails closed when those credentials are absent: npm publication depends on the base, orchestration, routing, and model-directed OCI live gates running against the exact annotated release tag and source commit. When credentials are configured, they are exposed only to the final provider-call step; checkout, runtime setup, dependency installation, tag verification, and deterministic OCI validation do not receive them. Local credentials are never copied to GitHub automatically.
