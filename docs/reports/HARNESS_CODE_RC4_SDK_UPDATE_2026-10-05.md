# Harness and Code RC.4 SDK preparation

Prepared on 2026-10-05 from remote main
`dc737dec02bf7f68aa8f7178c3d613d2d08858a5`, after PR #175 and the subsequent
dependency updates had merged. No user changes were present. Open groups #165,
#166, #168 and #169 were excluded. Existing tags and npm versions were checked:
the matched RC.4 versions were unused, and RC.2/RC.3 remain unpublished.
The later Dependabot PRs #178/#179 propose older intermediate SDK versions;
this preparation supersedes those versions without incorporating their branches.

| Published dependency | Before | Candidate |
| --- | --- | --- |
| Core | 1.28.0 | 1.30.1 |
| Agents | 1.10.2 | 1.10.3 |
| Anthropic | 0.13.1 | 0.13.2 |
| OpenAI | 0.13.7 | 0.14.1 |
| Qwen | 0.16.3 | 0.16.4 |
| Vertex | 1.2.2 | 1.2.4 |

Meta 0.2.9 and Gemini 0.13.0 were already current. Harness, Code and Web
contributor pins and required lock entries are coherent with Core 1.30.1.
Code 0.3.0-rc.4 requires exactly Harness 1.4.0-rc.4; Desktop binds that engine.
Model pins, acceptance ceilings, protected workflows and historical mappings
remain unchanged. The new representative mapping copies the RC.3 models.

The [machine-readable registry report](HARNESS_CODE_RC4_SDK_UPDATE_2026-10-05.json)
records tarball hashes, integrity, resolved SDK source commits, release runs,
dependency ranges and verification limits. All six tarball identities, registry
signatures and Sigstore provenance bundles verified. The npm TUF refresh endpoint
returned HTTP 403 in this environment; verification used Sigstore's published
trust-root snapshot with standard certificate, SCT and transparency thresholds.

Core now uses hashed physical store identities and verified memory envelopes.
Backup/import retains that identity while exporting logical messages, validates
scope and retained runs before writing, and supports verified legacy run records.
Unverifiable legacy memory is rejected rather than silently promoted. See
[durable operations](../DURABLE_OPERATIONS.md) before changing existing workers:
keep a complete pre-upgrade backup, upgrade all workers together, and explicitly
migrate legacy memory from trusted application context. Cancellation settlement
also follows the new SDK's drained-worker `cancel_requested` state.

Continuity diagnostics were reproduced from repository source; the offline Mac's
scratch candidate was unavailable. New evidence retains bounded response shape,
known-field presence, byte/event counts, digest, finish category and token usage.
It never retains response text, arbitrary keys or raw provider events. Failure
stops subsequent phases without retrying. RC.3's immediate JSON evaluation failed
at Meta phase 2; its upstream cause remains unknown because the original stream
was not retained. Meta 0.2.9's usage fix does not establish that cause.

## Offline preparation evidence

- Full suite: 1,983 passed, 21 skipped, six failed. The same six failures reproduced
  on unchanged main: five detached-policy fixtures encounter the cloud sandbox's
  synthetic ancestor Git boundary, and one process fixture exceeds its strict
  one-second timing bound. Production policy validation was preserved.
- Focused persistence, interruption, migration and diagnostics passed; stable API,
  architecture, docs, release preflight, types and frozen locks passed. Root audit
  reported zero vulnerabilities. Code's 129 tests and Web's 38 tests passed.
- Installed Harness package and console PTY, installed Code terminal journeys,
  installed Web CLI and browser security journeys passed without provider calls.
- Eight npm/pnpm/Yarn/Bun consumer cases passed against the same tarball hashes.
  Bun cases required writable temporary/cache directories in this sandbox.
- Desktop types and bundles passed. Native macOS packaging/credentials were
  unavailable locally; OCI was unavailable because its image was not installed.
  Normal Linux/macOS PR CI remains necessary, including those platform gates.

The four-manager checks used Harness tarball SHA-256
`abee7c1be3ddf99df75f18f718ba702e05797e59c8e89667d79656e50ce9e935`
and Code tarball SHA-256
`e8390e2257ebafd1ff99eccc2fe07ddb19c51336b4e7175a70999ccd54e03044`.
The initial combined consumer report retained six successful npm/pnpm/Yarn cases
and two Bun installation failures caused by the read-only cache. A separate Bun
report records both successful cases with explicitly writable cache directories
and the identical artifacts. No provider transport was used in these checks.

These local artifacts came from the preparation checkout before its commit, and
do not constitute exact-head release admission. PR CI must bind its head and the
actual merge commit's separate CodeQL analysis. After review/merge, require the
exact main SHA's CI, CodeQL, terminal and Web runs. A new paid campaign requires
explicit scope and spend approval, followed by protected Harness certification
and publication, then Code checks against the real published engine. No live
calls, release dispatch, merge, tags, publication or stable promotion were made
during this preparation.
