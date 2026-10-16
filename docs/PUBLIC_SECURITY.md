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

The repository additionally uses a `main` ruleset with pull-request review, review-thread resolution, linear history, and required CI checks. Repository Actions default to read-only permissions; individual jobs must request any narrower write capability explicitly. CI lints `.github/workflows` with actionlint 1.7.12 and shellcheck. The checksum and the shellcheck exceptions for quoted node/bun programs are pinned in `.github/workflows/ci.yml`.

Harness release, Code release, and live certification each start with a job that has empty permissions and no secrets. That job executes only the resolver in the dispatched workflow file. It accepts an annotated `vX.Y.Z`, `vX.Y.Z-rc.N`, `code-vX.Y.Z`, or `code-vX.Y.Z-rc.N` tag, peels it to a full commit SHA, and continues only when that commit is the workflow commit and an ancestor of `main`. Later jobs check out that SHA. `id-token: write` is requested only after that job succeeds: Harness and Code publication on the `npm` environment, Code provenance generation, and Vertex workload identity on the `live-certification` environment. npm provenance, the Rekor HTTP 409 reuse for an identical DSSE entry, and the registry verification step are unchanged.

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

## Environment protection to confirm manually

The workflow file cannot create GitHub environment rules. Before the next npm publication or live certification, confirm these repository settings:

- `npm`: required reviewers; deployment branches and tags limited to selected tags `v*` and `code-v*`; the environment is the Trusted Publishing environment for `release.yml` and `release-code.yml`.
- `live-certification`: required reviewers; deployment branches and tags limited to selected tags `v*`; provider secrets and Vertex variables stay in this environment.
- Leave `main` out of both deployment allowlists. A dispatch from `main` is valid only when that commit is the annotated tag, and the tag ref is the approval target.
- Approve a deployment only after the resolve job log shows `resolved <tag> to <sha>` and that SHA is the workflow commit.
- Keep a tag ruleset that allows only annotated `v*` and `code-v*` tags, and blocks deleting or moving them.

The resolver's pattern is stricter than the `v*` and `code-v*` environment patterns. A tag that matches the environment pattern and is not an annotated commit on `main` stops before secrets or `id-token: write` are granted.
