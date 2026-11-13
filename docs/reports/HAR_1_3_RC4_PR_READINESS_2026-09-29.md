# Harness RC4 — PR readiness

The increment is prepared on `feat/provider-reliability-acceptance` for
review. No PR was opened and nothing was published. Protected release certification
requires external configuration and execution on the integrated commit.

## Final changes

- Harness `1.3.0-rc.4` and Code `0.1.0-rc.2`, with an exact dependency. Both versions
  were verified absent from npm. Published versions were not modified.
- Tarball with Vertex documentation, policy and MCP fixture; packaged links to
  development reports were removed. `artifact:check` passes, 322 files.
- Private Desktop pins `harness.version` and requires explicit tarball
  installation; it does not try to resolve the unpublished RC from npm when installing its tools.
  Build/package preserve version, installation and hash checks.
- Protected release requires six routes, compaction with approval, structured
  delegation, OCI, cross-process continuity and four cross-routes. Meta/Qwen/OpenAI
  models match the representative matrix for the new tag; historical pins
  and user default models are preserved.
- Vertex uses the official SHA-pinned action and OIDC; preflight checks configuration
  presence before consuming APIs. Secrets remain restricted to steps.
- The MCP smoke accepts an explicit immutable tarball without repackaging it.
- The Desktop capture fixture uses compositor capture after DOM
  assertions, with the window visible and awake. It preserves execution
  limits and all approval/rejection checks. It does not change production
  mode or replace functional tests with screenshots.

## Artifacts and validation

Harness SHA256:
`cd43a2e313b56303bb9476011574ac172b08a4fc0bfc624e2f97b9cb848a1b32`.
Code SHA256:
`12f0c5584a53b0371a338fb63748a7f238cdcbd8dd2850b5026b541f7dc1ccc0`.
All 244 Harness dist files match the build and installation used.
The companion JSON report contains results and evidence digests.

- `bun run check`: **1891 passed, 1 skipped, 0 failed**, plus architecture, documentation,
  contracts, types, migrations, evaluations, benchmarks and MCP/OCI/package smokes.
  The subsequent modification is limited to the Desktop screenshot fixture and validated
  through the watchdog and packaged walkthrough; that modification is not attributed
  to the earlier full-suite run.
- Code: types, **100 tests**, tarball inspection and Node 22.13/24.11 consumers.
  Four managers and both orders: **16 local and 16 global cases**. Additionally,
  four local cases with pnpm 11.25.0, the CI version (the first matrix used
  pnpm 10.19.0). Isolated test prefixes and registry; no operator global
  installations or claims about all platforms.
- Policy, review, observability, contracts, OCI delivery, recovery,
  delegation and governance: **65 installed phases** on Node 22.13.
- Real isolated MCP: exact package, Node 22.13, Node 24.11 and Bun 1.4.
- Local RC3 → RC4 transition: preserved session, incompatible approval rejected
  without invoking the model or writing, and recovery through the previous runtime.
- Unsigned macOS arm64 Desktop: packaged conversation/approvals, restart/diff,
  checkpoints and explicit review. Checkpoint CLI passed.
- Dependency audit without vulnerabilities; SDK redaction passed.
  The protobufjs postinstall remains blocked; it was not enabled.

## Live matrix of the same RC4

| Route | Model | Base / compaction / delegation / OCI / continuity |
| --- | --- | --- |
| Anthropic | claude-sonnet-5-5 | 5/5 |
| Vertex | gemini-3.7-flash | 5/5 |
| Gemini API | gemini-3.6-flash | 5/5 |
| OpenAI | gpt-6-luna | 5/5 |
| Qwen | qwen3.8-max | 5/5 |
| Meta | muse-spark-1.3 | 5/5 |

Continuity: **36/36**. OpenAI→Vertex/Anthropic/Gemini and Qwen→Meta cross-routes: **4/4**.
All these gates ran on RC4. Certification was not transferred from the
previous tarball. One invocation per gate, with the existing policy of up to three
internal transient retries in base/compaction; first-attempt success is not promised.
The previous competitive pilot remains bound to its local RC3 hash and is not relabeled
as a new RC4 campaign.

## Preserved failures and correction

The first consumer could not find Yarn; it completed with the existing temporary
executable. The first suite had six ENOENT errors because installation without scripts
removed the Electron binary; it was restored with the explicit installer used by CI
and the full chain passed. The first MCP invocation received the tarball as
runtime; the new artifact option eliminates that ambiguity.

Explicit-review attempts preserved animation-frame timeouts and a
compositor error. Disabling background throttling alone did not
resolve capture. The final fix neither increases timeouts nor removes assertions:
it requests capture directly with the window visible and awake.

## Requirements after the PR

1. Configure Anthropic/Gemini secrets and Vertex variables in `live-certification`
   as specified in `docs/maintenance/RELEASE.md`, with the authorized federated identity.
   The inspected inventory does not contain them; local credentials were not copied.
2. Review/integrate the change and obtain remote CI/CodeQL on the final commit.
3. Run protected release, representative evaluation and publication with
   integrity/provenance verification. Publish Harness before Code.

The full release gate still correctly rejects this branch with local
changes; it reports only a dirty tree and a branch other than main. Those
restrictions were not weakened to obtain green output before the PR.
