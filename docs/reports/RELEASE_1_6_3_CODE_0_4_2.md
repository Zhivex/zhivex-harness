# Harness 1.6.3 / Code 0.4.2 preparation

Historical preparation snapshot. Publication subsequently completed on 2026-11-10; see [verified publication and protected evidence](PUBLICATION_1_6_3_CODE_0_4_2.md). The candidate hashes and pending statements below describe the pre-publication state.

Date: 2026-11-10. Base: `8ef92245a0a3548c6ccba7e28fbcd1cdfd44bace`.
Target channel: `latest`. Status: prepared locally; protected release certification and publication pending.

Harness 1.6.3 and Code 0.4.2 are maintenance releases. Code pins Harness 1.6.3 exactly. Desktop remains private alpha with that engine binding. No public API, schema, default model or provider tier changes are introduced by preparation.

The private Web development registry pin remains Harness 1.6.2 for reproducible installation before publication. Its offline setup explicitly links the built candidate. Historical release records and mappings are preserved.

## Candidate validation

Local environment: macOS arm64, Node 22.21.0, Bun 1.4.3; Desktop uses Electron 44.9.3 / embedded Node 24.22.0. Logs and retained candidate tarballs are under the ignored `release-artifacts/1.6.3-code-0.4.2/` directory. These are preparation artifacts, not protected workflow release artifacts.

- `CI=1 ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run check`: passed; 2,373 tests passed, zero failed, one platform-specific skip. Includes architecture, documentation, stable contracts, runtime/tooling types, historical migrations, 8 offline evaluations, benchmarks, MCP and installed package smoke.
- OCI passed with Docker 29.9.2 and image digest `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`; it was not skipped.
- Installed consumers: all 8 combinations passed (npm, pnpm, Yarn and Bun, each in both installation orders) using the retained exact tarballs and offline fixtures.
- Code types/build and 166 tests: passed. Installed PTY journeys also passed with the retained exact Harness and Code tarballs.
- Web types/lint, 97 tests, browser journeys (no browser errors) and installed CLI/Web smoke: passed against Harness 1.6.3.
- Desktop types, packaging, empty-start and restart/recovery smoke: passed with the candidate binding. Native/security tests are included in the root suite.
- Release metadata preflight, exact Harness/Code artifact inspection and SDK redaction gate: passed.
- Root, Desktop and Web dependency audits: no vulnerabilities reported (160, 141 and 379 packages respectively). `bun pm untrusted` reports the existing blocked protobufjs postinstall; it was not enabled.
- Candidate versions returned HTTP 404 from the public registry on 2026-11-10; current published channels were not changed.

The default macOS temporary path aliases `/var` to `/private/var`. Web fixture path comparisons and consumer relative tarball paths failed under the alias. Repeating with `TMPDIR=/private/tmp` passed those fixture boundaries; source assertions were not weakened. Retain this environment setting for macOS reproduction.

SHA-512 of the retained preparation artifacts:

```text
f190c2541a35699f4861f2132aae2d78a9fd4ee0ed77fb2169b90e3eedc9da85ce428ca91c838dec51429166edd1377c51162cc73fad0f325cba0e4dd23d7a15  consumers/harness.tgz
0ce17c524c04d83fb762756632f59faa32fc0ac16ab573183569cae941a2aae5825c45cd5484ae04c7866ad7820c503dc1623e37479387c20aa9cb3301bda065  consumers/code.tgz
```

Preparation checks ran on the working-tree candidate based on the SHA above. They do not certify a future merge SHA. `check-release-readiness --channel latest --registry` reported only the expected uncommitted-worktree and non-main-branch conditions at that stage. The final clean-main check must run after integration. No local provider credentials were configured; six-provider live and representative certification require the protected GitHub environment.

## Protected publication sequence

1. Review and integrate the preparation into main; require CI, CodeQL, Code installed journeys and Web to pass on that exact main SHA, including the separate security result.
2. From clean main, run `bun run release:prepare --sha <full-main-sha>` for the read-only release preflight.
3. With publication authorization, create the annotated Harness tag and dispatch its protected workflow using `bun run release:prepare --sha <full-main-sha> --publish`. Mandatory exact-artifact, OCI, six-provider live, mixed-routing and representative gates must pass.
4. Verify Harness 1.6.3 registry bytes, latest tag and source-bound provenance before creating annotated `code-v0.4.2` on the same reviewed SHA and dispatching `release-code.yml` with `channel=latest`, `mode=oidc` and publication confirmation.
5. Require Code's actual registry dependency resolution and retained-artifact acceptance; verify registry bytes and provenance. Update release-status and published documentation only with the new evidence.

No local passing test substitutes for protected live certification or real registry resolution of the unpublished engine. No release tag, publication workflow or package publication is performed during this preparation.
