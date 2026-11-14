# Harness 1.7.0 / Code 0.4.3 preparation

Date: 2026-11-13. Base: `e8df3cd4f3f1e35eb7245f185584903128d98767`.
Target channel: `latest`. Status: local preparation; publication pending.

Harness 1.7.0 introduces the additive experimental profiled engine API. Code 0.4.3 pins this engine exactly and includes the terminal/web presentation changes since Code 0.4.2. Private Desktop binds to Harness 1.7.0. Default models, provider tiers, stable coding APIs and storage formats remain unchanged.

Assistant remains private at 0.0.0. Its registry bootstrap dependency stays 1.6.3, and Web's stays 1.6.2, so frozen dependency installation works before publication. Their explicit local preparation steps replace those bootstrap engines with the candidate. Assistant's real-account pilot and 90-trial evaluation are separate pending work, not implied by offline integration results.

## Web workflow regression

The main-branch browser smoke failed after a cross-tab cancellation and a rejected model selection. Its retained screenshot shows an explicit `BUSY` response to session creation, not a lost response. The adapter rejects competing mutations before admission while another request owns its lock. The test previously ignored that response and waited for `Ready` until timeout.

The smoke now inspects the creation response and allows at most ten explicit new UI attempts only after a confirmed `BUSY` rejection. Lost, malformed and other failed responses are not retried. A forced `BUSY` regression reproduced the old 30-second timeout and passed with the fix, asserting exactly one additional session. The complete browser journey passed with no browser errors. CI now retains the failure text alongside screenshots.

Release preparation also requires successful exact-SHA main push runs for Web, Code installed journeys and Assistant, in addition to CI and CodeQL. Regression tests verify that each failed workflow blocks every publication mutation.

## Local validation

Environment: macOS arm64, Bun 1.4.3, Node 22.21.0. `TMPDIR=/private/tmp` avoids macOS temporary-path aliases. Local sockets and Docker were enabled for the offline checks.

| Validation | Result |
| --- | --- |
| `CI=1 ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run check` | Passed: 2,376 tests, zero failures, one platform skip; architecture, documentation, stable contracts, runtime/tooling types, migrations, 8 offline evaluations, benchmarks, MCP and installed package smoke |
| Required Docker OCI | Passed, Docker 29.9.2; image `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9` |
| Release preflight regression tests after adding workflow gates | 16 passed, zero failures |
| Final preflight, release status and changelog tests | 28 passed, zero failures |
| Web types, lint and tests | Passed; 97 tests |
| Code types/build and tests | Passed; 170 tests |
| Web browser journey with forced BUSY rejection | Passed; zero browser errors |
| Assistant local and isolated installed consumer | Passed; types, 130 tests in each consumer, offline example; installed runtime asserts Harness 1.7.0 |
| Assistant browser flows | Passed; daily/proactive setup and persistence, Microsoft OAuth fixture, mobile layout |
| Exact Harness and Code tarball inspection | Passed |
| Bun installed consumers, both installation orders | Passed with the retained Harness and Code tarballs |
| Installed Code terminal journeys | Passed with the retained tarballs |
| Installed Web CLI smoke | Passed with the retained tarballs; provider fetch denied, zero attempts |
| Clean-source installed task UI and recovery | Passed on `c2a2819915eed22ef1330a311eac9681a1899df4`; exact artifact bytes verified, recovery/projection/browser scenarios passed, cleanup completed |
| Desktop candidate binding and types | Passed against the retained Harness tarball |
| SDK redaction gate | Passed |
| Dependency audits | No vulnerabilities reported: root 160, Web 379, Assistant 203, Desktop 141 packages |
| Registry absence | Both candidate versions returned HTTP 404 on 2026-11-13 |

The existing protobufjs postinstall remains blocked; no lifecycle trust was added. Native-shell generated Assistant files are ignored without deleting local files. Assistant's installed smoke excludes that local native-shell directory and verifies the actual candidate runtime version instead of requiring the older registry bootstrap pin to equal an unpublished version.

Local preparation artifacts and logs are retained under ignored `release-artifacts/1.7.0-code-0.4.3/`. These are not protected workflow artifacts. SHA-512:

```text
5b489a7377434d6d57f6d069c4c4b24248ae1b11a738e74adcbd7199b18d07d56497cec687a82f88a1f7f8c9e72232c45fcdd6a0943f74b66b69810527dc0d10  harness.tgz
3b6b4aa557341e469fc38e841bf07b3a40680d48f6b4e08dee73b20b709c27d94a37542d3b17c22cbf1e58b8a18cf73c70cedac15f46fee2d380cab225851b13  code.tgz
```

## Remaining release gates

- Review and integrate the candidate, then require all five workflows on the exact final main SHA. Existing green checks for the base commit do not certify these changes.
- From clean main, repeat the read-only release preparation and registry-absence checks. Local readiness on the committed preparation branch reports only the expected requirement to run from main. The clean-source task UI journey passed after its initial refusal of uncommitted source; this final documentation update does not change the validated runtime or tarball bytes.
- Obtain fresh six-provider live and 42-case representative evidence bound to the final source and artifact through the protected release process. Local protected credentials are absent; no live-provider campaign was run. The 1.6.3 certification remains historical.
- Publish Harness only after separate authorization and all protected gates pass, then validate actual registry resolution before any Code publication. No tags, pushes, registry changes or publication dispatches were performed during this preparation.
