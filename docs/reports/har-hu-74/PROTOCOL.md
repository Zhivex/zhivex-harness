# HAR-HU-74: preregistered offline instrument, version 1

Status: draft until evaluator source commit and run manifest are frozen; no human or live-provider result.
Canonical story: https://app.notion.com/p/3ef777b104f6815cb922fb8f065639d3.
Scope decision: HAR-HU-61. This is an evaluation-tooling delta, not a runtime,
security, release, SDK, multiagent or product-surface change.

## Candidate and comparison

The product under test is CODE05/HU75 candidate
`f3f8cf00c6272717731e778af646f9eff9887f81` (PR195 draft), independently installed
from Harness archive SHA256
`fe243daaec37464a2ced8454c724878248b14bbb39f333b082d52d9d86073670`
and Code archive SHA256
`86dbcb85ff9dcbb619bee003adab1531148b762dede53bb6edc26603911b889d`.
The evaluator source commit is a separate identity. Freeze both before execution.
Registry publication, merge and remote approvals are not inferred from archives.

A paired baseline packet contains the objective, exact Git diff, deterministic
check receipts, governance record and cumulative task account. The treatment
packet contains the same objective/artifact plus the public task projection.
Both come from the same run and artifact; neither arm generates another answer.
Packet construction timings measure different local operations and are not a
comparison of human interfaces or proof that either arm saves review time.
The protocol does not rerun the browser journey already covered by CODE05.

## Frozen tasks and journeys

Two synthetic specifications: (1) named `greeting(name)` returns exactly
`Hello, ${name}!` for valid strings; visible vector Ada. (2) named
`totalActive(rows)` sums integer `amount` only where `active === true`, preserves
input, including empty inputs; visible vector two active rows with amounts 2,3.
Only one module is editable per task. Package/check files remain protected.
A synthetic single agent requests a digest-bound edit, the required check, then
stops. One writer, native execution, SQLite, trusted Git workspace. No child,
routing, compaction, replay, network model or retry is configured.

Order: repetition 1..3, fixture greeting then totalActive, journey normal then
handoff. Twelve registered positive attempts; no warmup or discarded sample.
This count follows this small factorial design, not an inherited corpus gate.
Normal proceeds to review. Handoff terminates the first worker process after
its durable completed run, edit and check, waits for exit, then opens another
worker against the same workspace. It is a post-execution interruption before
review, not an in-flight crash, concurrent takeover or proof of human continuity.
HU75 separately covers interrupted active effects. Both retain semantic review
pending and human acceptance unrecorded. No fabricated click grants acceptance.

Caps per task: 16 steps, 40 tools, 150000 ms, 60000 input tokens, 8192 output,
68192 total. Whole worker timeout 180000 ms includes process setup; timed-out
attempts remain failed in the ledger. There are no automatic task retries.
A correction to the instrument requires a new source/manifest/run ID and keeps
all previous reports. Never tune from a holdout outcome and reuse that result.

## Independent oracle and negatives

The reviewer created a holdout outside the repository and editable workspace:
SHA256 `496019c5c3f389dbd6fa68bb4945dfde1951845b5d14ebc8149a50612849be27`.
It has three additional vectors per fixture and two incorrect implementations
per fixture that pass visible examples. Freeze oracle, generation, manifest and
this digest before opening its content. Do not expose holdout to the mock agent.
The investigator can access the file; isolation means withheld from generation,
not a claim of cryptographic blinding. Expected values come from specification.

The oracle imports exact final module bytes in an isolated child, checks named
export, visible and holdout outputs, and input immutability. It also requires
current artifact/check correspondence, verified structure, protected-file
integrity, no unknown material effects, and evidence support. Assistant prose
is never evidence. Missing, malformed or unsupported fields fail closed.

For each fixture, independently reject two held-out wrong implementations plus
six evidence mutations: stale artifact, incomplete check, unsupported/fake
citation, altered reported numeric output, protected-file drift, unknown effect.
Sixteen negative cases are a separate denominator from twelve positive attempts.
Register negatives before execution as well. Require a passing positive base for
each fixture before crediting its negative controls; evaluator errors are failures,
not correct rejections. All registered cases, errors, failures and timeouts remain visible. Zero false
acceptances is mandatory for claiming the instrument passed its controls.
These controls do not establish completeness against arbitrary malicious code.
All executable fixtures are trusted, bounded local test modules.

## Measurements and accounting

Use monotonic milliseconds. Record task execution, baseline materialization,
projection fetch, post-exit reopen/read, and oracle duration separately. Summarize
n/min/p50/p95/max by fixture and journey with nearest-rank quantiles and no
outlier removal. Failed/timed-out observations are reported separately with
elapsed time; they do not silently enter successful-operation percentiles.
Publish registered, completed, failed and timeout counts beside percentiles.
With three repetitions p95 is the maximum: descriptive local timings only.
Record OS, architecture, CPU, runtime versions, evaluator commit, dependency lock,
archive digests and every installed product byte before/after execution.

The ledger registers before dispatch. Each row records attempt identity, status,
first-attempt versus recovery, humanAccepted=null, humanMinutes=null, quality
oracle result, all execution errors, repeated edit/check/model counts, and the
last cumulative budget snapshot. A handoff is a read of the original task, not
an extra successful task. Never sum successive cumulative snapshots.
A retry, if authorized in a future run, must remain attached to its original task.

Model token counts are synthetic accounting fixtures. Mock LLM cash cost is
N/A, never zero-priced production inference. Human, infrastructure and unpriced
provider costs remain unknown. The generic ledger includes failed attempts,
retries, compaction, review, routing and children if present; absent categories
are explicit not-used. Synthetic arithmetic tests are not real cost evidence.
Total known spend and unknown categories are reported even if accepted count is
zero. Cost per accepted task is undefined at zero and unknown if any material
cost is unknown. Distinguish oracle acceptance and human acceptance denominators.

## Future human experiment and provisional decision targets

No human participant, external team contact or paid provider is authorized here.
An empty worksheet records actual setup, review, correction, reconstruction and
reconciliation minutes for every reviewer, never agent/tool elapsed time.
Use matched task variants, blinded independent reviewers, counterbalanced arm
order, two reviewers plus a third adjudicator. Freeze inputs, environment,
budgets, provider/prices, quality and timing boundaries before that experiment.
Use an untouched holdout and record every failed/negative/discarded attempt.

ADR61 targets remain provisional: quality >=9/10 across five 0..2 dimensions
(functional, scope, current/complete evidence, uncertainty/effect recognition,
handoff continuity), with full functional/scope and all required checks; paired
median reviewer minutes/accepted task improvement >=20%, no lower quality,
no increased total human minutes, zero false acceptances or scope violations;
>=90% handoffs without transcript reconstruction or repeated irreversible effect;
complete cost/accepted task increase <=10%. Missing material data is inconclusive.
These are not outcomes of the fixture oracle, not ratified live thresholds and
not the historical 5/6 or 10/12 success rule.

A separate approval may admit 3–5 teams for two weeks, at least five paired tasks
per team, within frozen safety and spend limits. No-go for false acceptance,
unsafe repeated effect, quality regression or accounting gaps; inconclusive for
missing human/live data. Single agent remains baseline. Multiagent/routing/replay
requires a separately approved equal-capability/equal-budget experiment and
measured gain. Offline instrument success does not close HU74 or release product.
