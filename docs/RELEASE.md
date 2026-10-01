# Release process

`@zhivex-ai/harness@1.2.0` is the latest public npm release. The historical `v1.0.0` publication and its exact source, registry integrity, SLSA provenance, GitHub Release and release-bound live evidence remain recorded in the mutable repository [release-status.json](https://raw.githubusercontent.com/Zhivex/zhivex-harness/main/release-status.json), excluded from immutable npm artifacts. See [LIVE_CERTIFICATION.md](LIVE_CERTIFICATION.md).

## 1.3.0-rc.6 preparation

The source version is `1.3.0-rc.6`, targeting npm `next` through annotated tag
`v1.3.0-rc.6` and the protected GitHub Actions workflow. Stable 1.2.0 remains on
`latest`. RC3 includes HAR-HU-36–38: public engine boundaries, compatibility
bridges and an independently built local Code package.

RC5 incorporates the provider, Desktop, MCP/ACP, checkpoint and governance
increments. The protected live cohort pins Qwen `qwen3.8-flash`, Meta
`muse-spark-1.3-contributor`, OpenAI `gpt-6-luna`, Anthropic `claude-sonnet-5-5`, Gemini API
`gemini-3.6-flash` and Vertex `gemini-3.7-flash`. All six must pass base,
approval compaction, structured delegation, OCI execution and multi-process
continuity. Four routing gates cover OpenAI to Vertex/Anthropic/Gemini and Qwen
to Meta. Representative repository evaluation remains the separate three-route
Meta/Qwen/OpenAI cohort; its model pins match the live cohort.
Code `0.1.0-rc.2` is now prepared for a separate `release-code.yml` workflow and
its own annotated tag; see [Code release procedure](CODE_RELEASE.md).

Each later RC must bind its own source SHA, exact tarball, CI/CodeQL, installed
acceptance and protected live/representative evidence. Previous RC results do not
certify new bytes. Do not overwrite immutable versions or advance `latest`.
The engine/Code installed gate uses the exact release tarball without changing
its manifest version; Code is packed only for consumer acceptance, not published.

RC3 and Code RC1 are already published. RC4 and RC5 failed before publication.
RC6 and Code RC2 remain unpublished; their evidence must bind their own bytes.
Historical records, including `release-status.json`, do not certify RC6.
RC6 includes PR #152 execution, manual-cohort, continuity-diagnostics and
canonical-tag WIF fixes, preserving the RC5 model pins.

RC4 at `f83e88f55e9f865c43abfc636e9b797c845fe258` failed; its tag and
model mapping remain historical evidence. RC5 includes the empty Anthropic
endpoint fix from PR #149 and restores the Flash/Contributor certification pins.
User model defaults and the catalog are unchanged. Gemini API 3.6 Flash and
Vertex 3.7 Flash remain pinned; the conditional cost-based 3.8 change is not
part of this candidate. Preparation does not authorize paid live runs, tagging,
release dispatch or publication; those steps require separate approval.

### Protected configuration before RC6 release

The `live-certification` environment requires secrets `OPENAI_API_KEY`,
`MODEL_API_KEY`, `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`), `ANTHROPIC_API_KEY`
and `GEMINI_API_KEY`. Optional route settings use the existing provider-specific
base URL, Qwen region and workspace secrets. A presence-only preflight rejects
missing configuration before paid gates and prints names, never values.

Configure environment variables `GOOGLE_CLOUD_PROJECT`, `VERTEX_LOCATION`,
`VERTEX_WORKLOAD_IDENTITY_PROVIDER` and `VERTEX_SERVICE_ACCOUNT`. The pinned
Google auth action creates short-lived ADC via GitHub OIDC; the identity must be
authorized for this repository and protected environment and for the selected
Vertex route. Local user ADC is not copied to GitHub. Auth-generated credential
files are ignored and never included in artifact uploads. The job requires
`id-token: write`; authentication failure blocks every subsequent paid gate.

The Vertex WIF condition must admit future canonical release tags rather than
enumerating individual RC refs. Generate the reviewed condition with
`bun run scripts/vertex-release-identity.ts`. It requires the repository and
owner numeric IDs, the protected `live-certification` environment subject,
`workflow_dispatch`, a canonical `vX.Y.Z` / `vX.Y.Z-rc.N` tag and an exact
workflow/ref binding for `release.yml` or `live-certification.yml`. Branches,
pull requests, other workflows, environments and repositories remain excluded.
Apply this condition to the configured provider through an authorized IAM
change, retain the previous condition for rollback and re-read it afterwards.
Presence checks do not verify IAM; successful GitHub OIDC authentication remains
required before paid provider gates. Local cloud access is not GitHub identity
certification.

Manual live certification defaults to all six routes and runs the same base,
approval compaction, structured delegation, mixed routing, OCI execution and
conversation continuity gates as the release. A diagnostic provider subset
limits the per-provider gates; the four fixed mixed routes still require the
complete six-route configuration and Vertex authentication. Manual evidence
does not replace the release-bound representative matrix or published-byte
verification.

The execution smoke uses a host-owned `live-execution-fixture.mjs` in the OCI
snapshot. The model must submit the exact reviewed `node` argv, inspect its
patch and obtain separate host-import approval. Certification checks the final
provider file, unchanged fixture, execution binding, tool sequence and unique
journal entries. Keeping JavaScript out of the model-authored argv avoids false
failures from source rewriting without accepting arbitrary programs.
Continuity emits one sanitized JSON envelope per campaign, preserving provider,
failed phase, allowlisted failed checks and typed provider diagnostics in the
aggregate gate; raw conversation and provider output remain excluded.

The previous `v1.3.0-rc.1` attempt failed the Qwen base certification because
its pending `apply_patch` proposal ID differed from the expected ID. npm was
never invoked. RC2 validates proposal digests before requesting approval, so an
invalid model call receives an input error rather than an unusable approval.
The exact live assertion and provider cohort remain unchanged; the historical
tag and artifact are not moved or rewritten.

## RC3 operator decision

After complete local validation, the corrected artifact passed OpenAI 14/14 and
Qwen 14/14; Meta passed 13/14 and returned HTTP 504 `server_error` in the remaining
SQLite case. No unauthorized effects occurred and the process exited naturally.
The operator explicitly authorized advancing the RC despite this provider-side
HTTP failure. The precise upstream internal cause remains unknown.

This authorization permits preparing and uploading RC3; it does not turn 41/42
into full certification. The current protected workflow has no failure waiver:
publication still requires successful exact-artifact validation, live gates,
representative matrix and environment approval. Historical RC1/RC2 tags remain
unchanged. See the [local campaign](reports/RC2_RECOVERY_REPRESENTATIVE_2026-09-28.json).

## Recovered proposal certification

A schema rejection before approval is a result receipt, not a workspace execution.
The base gate snapshots persisted results before resume and allows only retained
`TOOL_INPUT_VALIDATION_ERROR` receipts with the same tool-call IDs. New errors,
missing or duplicated receipts, execution failures, and results for an unapproved
call remain failures. No apply-patch journal entry may exist before approval;
after resume there must be one successful result for the approved call, one
completed journal entry, and the exact expected file content.

The deterministic proposal-recovery test runs the same effect assertion after
closing and reopening the durable store. This connects the runtime's recovery
contract to the release gate instead of testing each in isolation. It does not
replace full artifact live and representative certification.

## Deterministic gates

From a clean checkout on `main`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun install --cwd desktop --frozen-lockfile --ignore-scripts
# macOS: the full test suite also exercises the native Desktop worker.
if [ "$(uname -s)" = Darwin ]; then
  node desktop/node_modules/electron/install.js
fi
bun run release:check
git diff --check
git status --short
```

`bun run release:check` performs documentation validation, typechecking, deterministic tests, the golden evaluation gate, the required real-OCI boundary gate, a dependency-externalized build, package-content validation, clean tarball installation, direct binary execution, public import, SDK execution-environment import, SQLite restart/resume, redacted inspection, exactly-once side-effect verification, dependency audit, untrusted lifecycle-script inspection, dry-run packing, and release metadata validation.

Contributor builds use TypeScript 7.0.2. The separate `typescript-compiler-api`
alias intentionally stays on TypeScript 6.0.3: architecture and Stable API
signature checks depend on its JavaScript compiler API, which the TypeScript 7
package root does not expose. Upgrade this alias only alongside a validated
migration of both checks.

CI repeats the deterministic and installed-package gates on Linux and macOS. Build output is ignored and must not create tracked changes.

## Live gate

Provider behavior is certified separately because it is credential-, account-, model-, endpoint-, and date-dependent:

```bash
export ZHIVEX_HARNESS_LIVE_META_MODEL=muse-spark-1.3-contributor
export ZHIVEX_HARNESS_LIVE_QWEN_MODEL=qwen3.8-flash
export ZHIVEX_HARNESS_LIVE_OPENAI_MODEL=gpt-6-luna
ZHIVEX_HARNESS_LIVE=1 bun run scripts/live-provider-smoke.ts
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:orchestration
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:routing
ZHIVEX_HARNESS_LIVE=1 bun run smoke:live:execution
ZHIVEX_HARNESS_OCI_REQUIRED=1 bun run smoke:oci
```

The base reviewed-edit gate and the separate delegation gate must pass for every provider in the supported release matrix. The release workflow additionally requires the mixed-provider route, model-directed execution, and representative repository gates against the exact annotated tag before the npm job can start; deterministic OCI enforcement remains a separate prerequisite. Gemini is explicitly provisional and excluded from the 1.0 cohort under [GEMINI_1_0_DECISION.md](./GEMINI_1_0_DECISION.md). Integrated provisional providers must not be described as certified. `bun run check` also runs controlled Streamable HTTP MCP interoperability gates; each external implementation claim remains bounded to the tested server/version. See [LIVE_CERTIFICATION.md](./LIVE_CERTIFICATION.md).

## Exact artifact gate

The release workflow performs this sequence across an unprivileged validation job and a protected publication job:

1. check out an existing annotated `v<package-version>` tag with complete history;
2. prove that the tag resolves to `main`, the worktree is clean, and the version is absent from npm;
3. run the complete release gate with Bun-managed contributor tooling and the supported Node runtime;
4. create one tarball with `bun pm pack --ignore-scripts`;
5. allow only the documented package roots, verify the packed manifest, and write `SHA512SUMS`;
6. install that same tarball in an isolated consumer and execute its CLI and public API;
7. extract the validated tarball and run the protected base, orchestration, routing, and model-directed OCI live gates through its public runtime; require the artifact path and matching version, including approval child processes;
8. run the 14-case governed representative repository matrix for Meta, Qwen, and OpenAI against the same artifact binding and one digest-pinned OCI image; reject missing/selective/unsafe runs and upload only the strict sanitized evidence document;
9. transfer only the tarball and `SHA512SUMS` into the `npm` environment, then revalidate the checksum and artifact contract;
10. pass that same file to the npm CLI for the registry transaction; and
11. retry within one absolute five-minute deadline through registry and attestation propagation, capping every request and sleep by the remaining time, then verify the distribution tag, byte-identical SHA-512 integrity, and SLSA subject/repository/workflow/ref/commit evidence. The ref must be `main` or the exact `v<package-version>` tag; arbitrary branches and tags fail closed.

For a local artifact rehearsal after the source gate:

```bash
mkdir -p release-artifacts
HARNESS_VERSION="$(node -p 'require("./package.json").version')"
HARNESS_ARTIFACT="release-artifacts/zhivex-ai-harness-${HARNESS_VERSION}.tgz"
bun pm pack --filename "$HARNESS_ARTIFACT" --ignore-scripts
bun run artifact:check -- "$HARNESS_ARTIFACT"
bun run smoke:artifact -- "$HARNESS_ARTIFACT"
```

The manual tag-bound live-certification workflow runs `bun run build` immediately before packing. This is required because its readiness preflight validates source and release identity but does not create `dist/`; a source-only tarball is not valid release evidence.

`release-artifacts/`, `.npmrc`, `.env`, source tests, Git metadata, and local run state are excluded from the package. Development reports under `docs/reports/` and historical benchmark JSON under `benchmarks/baselines/` also remain repository-only archives. Published guides link to those archives; artifact validation rejects accidentally bundled copies.

## External prerequisites

Before a release dispatch, reverify repository/package visibility compatibility, protected-environment reviewers, package ownership with 2FA, and that the Trusted Publisher identity matches the repository workflow. Do not rely on a previous release's state.

The release workflow intentionally supplies no long-lived registry token. Do not introduce one as a fallback; a failed OIDC assertion is a stop condition to diagnose.

Trusted Publishing currently requires npm CLI `11.5.1` or newer and Node `22.14.0` or newer. The workflow follows npm's current Node 24 guidance and uses npm only for the OIDC/provenance-aware registry transaction. Dependency management, tests, and packing use Bun as contributor tooling; the built CLI, public library, SQLite reopen, and installed artifact execute under Node.

## Release preparation preflight

Run `bun run release:preflight` to check the candidate's dated changelog and
representative tag/model mapping before expensive gates. CI runs this check with
`--allow-unreleased`: development headings remain valid, while dated candidates
must include an exact certification mapping consistent with the release workflow.
The protected release additionally checks tag, channel, source identity and registry
absence before pulling the OCI image or running the deterministic suite.
Dependency audits use the same bounded transient-outage retry policy as CI;
vulnerabilities and other errors still fail immediately.

From a clean `main` checkout at the intended remote commit, after CI and CodeQL:

```bash
# Read-only; replace the placeholder with the full reviewed main commit SHA.
bun run release:prepare --sha <full-main-sha>
# Explicitly confirm creation of the annotated tag and protected publication.
bun run release:prepare --sha <full-main-sha> --publish
```

The command derives version and channel from `package.json`, requires the latest
main push runs of CI and CodeQL to have passed for that exact SHA, and rejects
an active release for the same SHA. It never moves existing tags: an existing
annotated tag must resolve to the same commit. Creation uses an atomic ref create;
a competing creation fails rather than overwriting it. Dispatch uses the exact tag
to avoid a concurrent main update selecting a different workflow commit. The
protected workflow retains all artifact, live, representative and OIDC gates.
The default preflight does not certify live providers or publish anything.

Validated tarballs and checksums are retained for 30 days for exact-byte recovery.
The workflow summary reports every gate; the registry transaction summary separates
verified publication, accepted publication pending verification, and a failed
transaction whose registry acceptance is unknown. A failed publication command
must not be interpreted as proof that npm did not accept the version. If the
artifact has expired, stop and recover the original bytes and evidence rather than
rebuilding an already accepted version.

## Tag and dispatch

After review and merge, maintainers create an annotated `v<package.json version>` tag from the exact release commit and dispatch the protected workflow with that tag plus an explicit publication confirmation. The workflow YAML contains no release-version default: `package.json` is the source of version truth, and the required tag input is validated against it before publication. Manual dispatch may use `main` only while it equals the tagged commit. The preparation command dispatches the exact annotated tag after proving it matches reviewed remote `main`; the workflow verifies the checkout equals its dispatch SHA and remains reachable from `origin/main`.

The confirmation is intentional because registry versions are immutable, and the protected environment adds a second human approval boundary. Do not use a local registry session or manual upload as an alternate path.

Release candidates use versions and annotated tags such as `1.0.0-rc.1` / `v1.0.0-rc.1` and must publish to `next`. Stable versions must publish to `latest`; the readiness gate rejects either channel mismatch before registry mutation. The representative assembly matrix explicitly authorizes RC.1 through RC.14 and the final `v1.0.0` tag and pins the Meta, Qwen, and OpenAI model for each, so both candidate and stable publication execute the exact unpacked tarball runtime rather than a checkout-only build. Failed immutable attempts remain in the readiness ledger but do not count toward GA. Before any `1.0.0` dispatch, `bun run readiness:1.0:release` must pass. That gate requires two complete passing RC records, current security and representative evaluation evidence, historical migration fixtures, and no open GA blocker. Release execution stops subsequent gates and providers after a confirmed failure; bounded transient retries inside a gate are unchanged. Representative evaluation starts only after live certification succeeds. The final aggregate and sanitized diagnostic upload always run, and skipped gates never count as passed. Manual live certification retains exhaustive diagnostics; standalone live smoke scripts enable release behavior with `ZHIVEX_HARNESS_LIVE_FAIL_FAST=1`. Every live/OCI phase, including image preload, runs through its own diagnostic wrapper. Failed jobs upload only bounded, strict-schema outcomes self-bound to the release tag, source commit, canonical tarball SHA-512, workflow run, and `github.run_attempt`; representative diagnostics additionally bind provider/model, driver commit, and OCI image digest. Cross-provider identity drift, a missing binding, or an incoherent passed/failed state is treated as unavailable evidence. Raw child stdout/stderr is not relayed, and raw prompts, provider output, error messages, response bodies, headers, credentials, run identifiers, and stacks remain excluded. See [GA_READINESS.md](./GA_READINESS.md), [ROLLBACK.md](./ROLLBACK.md), and [DEPRECATIONS.md](./DEPRECATIONS.md).

If npm accepted the immutable version but the post-publication verifier failed during propagation, rerun only the failed `publish` job. It downloads the already validated artifact, skips `npm publish` only when the registry version has byte-identical integrity, and repeats the registry/provenance verification. Never rebuild, bump, or republish the same version to recover a post-publication false negative.

## Publication stop conditions

Do not dispatch or approve publication when any of these is true:

- the repository is not public, the tag is not annotated, the tagged commit is not on `main`, or the worktree used to create it was dirty;
- deterministic, installed-artifact, required live-provider, representative-repository, or release-artifact evidence failed;
- package scope ownership, 2FA, the intended `public` access level, or the protected environment is unclear;
- the inspected package contents and the to-be-published artifact are not the same file;
- the package version already exists in npm;
- an npm token or `NODE_AUTH_TOKEN` has been reintroduced into the OIDC-only workflow;
- Trusted Publishing is expected but its repository, workflow filename, environment, or allowed action disagrees with the workflow; or
- version, changelog, tag, registry metadata, source commit, integrity, or provenance disagree.

Current npm requirements should be revalidated against the official [Trusted Publishing guide](https://docs.npmjs.com/trusted-publishers/), [provenance guide](https://docs.npmjs.com/generating-provenance-statements/), and [Bun packaging documentation](https://bun.com/docs/pm/cli/publish) before any registry mutation.

Representative diagnostics checkpoint completed cases atomically after each case. A later report or cleanup failure retains those results and adds a terminal failure with its exact phase; it does not reset the matrix to zero. Semantic failure classifications and their original Harness wrappers are retained independently. Error details contain only a bounded chain of allowlisted error kinds/system codes, HTTP status numbers and retryability, plus validation issue counts and allowlisted issue types. Messages, validation paths/inputs, arbitrary codes, headers, response bodies and stacks are never copied. Fingerprints identify the sanitized structure, not a unique raw exception.

Representative drivers emit bounded checkpoints on a separate pipe to the benchmark
supervisor. A hard timeout retains the last phase (runtime/provider setup, harness
creation, agent, approval, verification, close, evidence or cleanup), last allowlisted
event, elapsed/phase time and step/tool counters in `failure.details.benchmarkProgress`.
The release summary displays that checkpoint. It is the last observed activity,
not proof of the underlying cause. Raw event payloads and stderr are never copied.
Malformed, oversized or unknown checkpoint fields are ignored. The built-in driver
reserves up to 30 seconds inside the unchanged outer deadline for timeout handling,
verification and cleanup; the supervisor still fails and kills the driver at its
hard deadline if it cannot finish. Historical diagnostics without checkpoints remain valid.

Benchmark checkpoints also retain up to 24 operation spans and 16 phase transitions.
Spans distinguish model generate/stream calls, time to first text delta, transport
attempts (HTTP status and parent model-call number), allowlisted tool execution,
and OCI image inspection, container creation, execution/attestation, export and
cleanup. Transport timing ends at response headers; stream timing includes body
consumption. Multiple transport attempts are observable, but their count alone
does not prove an SDK retry. Tool names outside the allowlist become `other_tool`.

Each checkpoint includes configured supervisor/agent/tool budgets, remaining total
time, and a timeout scope only when the supervisor, agent status or OCI result
confirms it. Setup time and repeated agent resumes may still exhaust the outer
budget first. Active spans continue aging in the supervisor after the last event.
Failed normal driver results retain their final checkpoint as well as hard-kill
failures. Actions includes a bounded per-case table with the last active operation,
inactivity, expired budget and a link to the run's diagnostic artifacts. The trace
is a bounded observation history, not a raw request log or a complete profiler.

Provider failure diagnostics apply to every provider using the shared model/HTTP
observer, including Meta, Qwen, OpenAI and Gemini. Rejected HTTP responses retain
only a fixed reason, allowlisted parameter, and body inspection state. Parsing is
limited to 8 KiB and 250 ms, preserves the original response for the SDK, and never
logs bodies, headers, URLs or messages. Unknown provider formats remain explicitly
unknown; these labels are classifications, not verbatim server explanations.
The most recent provider rejection survives span eviction and a later stream error.
Wrapped runtime errors also project the same structured provider fields into their
sanitized cause chain, including live gates outside the representative benchmark.

Driver lifecycle checkpoints distinguish `cleanup`, `cleanup_complete`,
`result_write`, `result_written` and `exit_pending`. After stdout is flushed, an
unreferenced one-second observer reports whether the process is still alive; it
cannot keep the process alive itself. Node reports bounded resource-type counts
without handle contents. Bun currently does not implement the resource inventory,
so it explicitly reports `unsupported` rather than claiming no resources remain.
A supervisor timeout after a valid failed result retains the original sanitized
failure chain as well as the supervisor timeout; it never turns that run into a pass.
The Actions failed-case table includes the provider rejection and resource inventory.

### OCI patch mismatch diagnostics

The OCI runtime persists the last inspected patch ID in its private, identity-bound
execution metadata before returning an inspection. This optional diagnostic receipt
survives approval restart; older artifacts without it remain readable. Import still
recomputes the full patch and checks the approved ID and host preconditions. The
receipt cannot authorize or substitute different bytes.

Sanitized release diagnostics distinguish `OCI_PATCH_ID_MISMATCH` (the current patch
still matches the last inspection, but the submitted ID does not),
`OCI_PATCH_SNAPSHOT_CHANGED` (the submitted ID matches that inspection, but the
current patch differs), and `OCI_PATCH_REVIEW_UNAVAILABLE` (missing or ambiguous
inspection evidence). A changed execution identity/binding is reported separately
as `OCI_EXECUTION_BINDING_CHANGED`. No digest values, paths, contents or tool
arguments are included in these diagnostics. Patch mismatches retain the
`PATCH_DRIFT` classification across sanitized child-process serialization.

A rejected import leaves the host unchanged. Recovery requires inspecting the
current patch and obtaining a new approval for that exact ID; do not rewrite a
pending approval or retry the old ID automatically. A terminal
`apply_environment_patch` call with a typed `OCI_PATCH_ID_MISMATCH` may return to
the model once per run with instructions to inspect again and request a fresh
approval. The failure receipt survives pause/resume, so resuming does not reset
that limit. Changed snapshots, unavailable review evidence, binding changes and
unknown effects remain terminal. No pending approval is rewritten.

The `v1.2.0-rc.1` attempt
([run 36204796627](https://github.com/Zhivex/zhivex-harness/actions/runs/36204796627))
passed exact-artifact validation and live gates, then stopped on Qwen's clean
`python-pytest-repository` case at `apply_environment_patch` with `PATCH_DRIFT`.
Meta passed 14/14, Qwen passed 13/14, and OpenAI and publication were skipped.
The historical diagnostics recorded zero unauthorized effects but did not retain
the inspection comparison, so they cannot establish which mismatch occurred.
Do not reinterpret that attempt as passing or attribute it to provider availability.

### Product and artifact coverage

Release and manual live workflows set `ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT=1`
and `ZHIVEX_HARNESS_LIVE_RUNTIME` to the extracted, inspected tarball. The base,
orchestration, routing and model-directed execution smokes load their Harness
functions, descriptors and error types from that runtime. A missing artifact,
wrong version or missing export fails before requests; local development alone
may fall back to source. The separate deterministic OCI smoke remains a source
boundary check.

Desktop CI packages the macOS application and exercises startup, approval/history
restart, interruption between an effect and its receipt, active-run cancellation,
and isolated worktree delivery/reconciliation. Closing with active work must offer
stay/cancel before awaiting an IPC that itself depends on that work finishing.
Accepted application operations still drain before hosts are closed. These are
fixture-backed product journeys, not live-provider or signed Desktop distribution
certification.

The complete representative matrix remains blocking and unchanged. The focused
[Python follow-up](reports/RC1_PATCH_FOLLOWUP_2026-09-26.json) is diagnostic evidence only; it cannot replace the full
cohort or certify a new release. It also predates the performance backport from
`95aee33`; the combined artifact requires its own complete live certification.

### Diagnosing reviewed-edit resume failures

The base live gate records separate checkpoints for `resume_result_count`,
`resume_result_success`, `resume_file_read`, `resume_file_content`,
`resume_journal_read`, `resume_journal_count`, and `resume_journal_status`.
Sanitized `editEffect` counters distinguish result receipts (successful or error)
from durable journal entries and completed entries. An error receipt alone does
not establish that a filesystem mutation executed. These are diagnostics, not
relaxed acceptance: the gate still requires exactly one successful write result,
exact expected file content, and exactly one completed journal entry.

RC6 failed at the earlier grouped `resume_effect` checkpoint before publication.
Its evidence cannot retrospectively identify which assertion failed; a later
successful local reproduction does not certify that failed release run.

### Pending OCI delivery diagnostics

The RC7 attempt failed the clean `hostile-instructions` case after editing and
running a command without importing the isolated patch. Its historical
`VERIFIER_FAILED` diagnostic is unchanged. New builds detect this boundary before
completion and distinguish `OCI_DELIVERY_PENDING`, `OCI_DELIVERY_DECLINED`, and
`OCI_DELIVERY_INSPECTION_FAILED`. Detection compares actual snapshot and host
contents/modes, including previously imported paths. It does not waive the final
verifier or grant import approval.

### Provider failure shutdown checks

Meta stream setup failures must retain the original provider error and exit
naturally without waiting for the model deadline. The adapter owns deadline
cleanup across setup and iterator termination. Subprocess regressions cover
HTTP/transport failures, stream errors, cancellation and deadlines; the installed
package smoke checks the same failure boundary under Node. A valid result on
stdout alone is not successful driver completion.

Desktop smoke retains a 90-second watchdog and records phase timing in
`progress.json`; renderer operations and failure snapshots have bounded waits.
A watchdog failure must include its evidence directory and last phase.
