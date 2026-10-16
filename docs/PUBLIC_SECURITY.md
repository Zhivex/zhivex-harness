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

Harness release, Code release, and live certification each call `.github/workflows/resolve-protected-release-ref.yml` from a job with empty permissions and no secrets. The call uses a relative `./` path, so GitHub loads that file from the same commit as the dispatched workflow. An off-main tag or branch can rewrite the resolver or omit the call. The resolver is defense in depth, not the trust boundary. The boundary is external: the `npm` and `live-certification` environments accept deployments only from the selected tag patterns below, and a tag ruleset lets only maintainers create matching tags and blocks updates and deletions. When the dispatched workflow still contains the resolver, it requires `GITHUB_REF` to be exactly `refs/tags/<tag>` for both Harness and Code. It then accepts only an annotated `vX.Y.Z`, `vX.Y.Z-rc.N`, `code-vX.Y.Z`, or `code-vX.Y.Z-rc.N` tag, peels it to a full commit SHA, and continues only when that commit is the workflow commit and an ancestor of `main`. Later jobs check out that SHA. `id-token: write` is requested only on those later jobs: Harness and Code publication on the `npm` environment, Code provenance generation, and Vertex workload identity on the `live-certification` environment. The environment still withholds that token unless the workflow ref is an allowed deployment tag. npm provenance, the Rekor HTTP 409 reuse for an identical DSSE entry, and the registry verification step are unchanged. Pinning `uses:` to a commit SHA in this repository or in another repository does not replace the environment rules or the tag ruleset: the workflow file selected by the dispatched ref still chooses the `uses:` value and can delete the call.

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

The workflow file cannot create GitHub environment rules or rulesets. Before the next npm publication or live certification, set these repository settings. They are the trust boundary.

- `npm`: required reviewers. Deployment branches and tags must be **Selected tags** with patterns `v*` and `code-v*` only. Do not include `main`, all branches, or any other pattern. This environment remains the Trusted Publishing environment for `release.yml` and `release-code.yml`.
- `live-certification`: required reviewers. Deployment branches and tags must be **Selected tags** with pattern `v*` only. Do not include `main`, any branch, or `code-v*`. Provider secrets and Vertex variables stay in this environment.
- Tag ruleset for patterns `v*` and `code-v*`: enable **Restrict creations**, **Restrict updates**, and **Restrict deletions**. Put only the Maintain role on the bypass list, so only maintainers can create matching tags and nobody can update or delete them. Repository admins can still bypass a ruleset unless the organization disables bypass; do not add a broader bypass list.
- Dispatch Harness release, Code release, and live certification from the exact tag ref (`refs/tags/vX.Y.Z`, `refs/tags/vX.Y.Z-rc.N`, `refs/tags/code-vX.Y.Z`, or `refs/tags/code-vX.Y.Z-rc.N`). A dispatch from `main` or any other ref is not a deployment tag, so these environments do not grant secrets or `id-token: write`. The resolver rejects that ref as well when the dispatched workflow still contains the check, including when the branch commit equals the tag.
- Approve a deployment only after the resolve job log shows `resolved <tag> to <sha>` and that SHA equals the workflow commit (`github.sha`).
- Environment patterns are coarse `fnmatch` globs. The resolver's regular expression is stricter, but it runs only when the workflow file on the dispatched ref still calls it. A ref the ruleset and the environment exclude never receives secrets or `id-token: write`, even if its workflow omits the resolver.
