# 1.0 readiness

[`ga-readiness.json`](./ga-readiness.json) is the fail-closed source for the 1.0 promotion gate. `bun run readiness:1.0` validates the preparation assets on every change. `bun run readiness:1.0:release` is intentionally red until all blockers are closed, the security and representative evaluation evidence is complete and recent, two published RCs have zero known contract-breaking defects, and `package.json` is exactly `1.0.0`.

The preparation gate does not certify production readiness. It verifies that public API/CLI/schema baselines, migration targets, support claims, security controls, rollback rules, and evidence requirements remain machine-readable and internally consistent.

## Promotion sequence

1. Complete contract and historical migration fixtures.
2. Publish `1.0.0-rc.1` to `next` through the protected exact-artifact workflow.
3. Run migration, representative repository, live provider, OCI, installed-artifact, integrity, and provenance gates against that tag.
4. Fix contract defects and publish `1.0.0-rc.2` to `next`; repeat the full matrix.
5. Record a current security review with no open critical/high findings.
6. Change the readiness phase to `ready` only after all evidence is committed and passes the release gate.
7. Publish `1.0.0` to `latest`; never promote an RC by merely moving a dist-tag.

Gemini remains provisional unless the exact candidate passes the complete provider matrix. Excluding it from the GA-supported provider list is a valid decision; silently treating partial evidence as certification is not.
