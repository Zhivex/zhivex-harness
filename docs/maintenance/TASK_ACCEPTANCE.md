# Common task acceptance

HAR-HU-44 defines `harness-tasks-v1` in `scripts/acceptance/fixtures.ts`.
The same seven fixtures run for every explicitly selected model and direct API
route: bug repair, multi-file change, failed check recovery, user correction,
compaction with durable reopen, approval before mutation, and cancellation.

The runner installs the supplied tarball in a fresh consumer with Bun, imports its
engine, and records the tarball's SHA-512 integrity, version, fixture digest, route,
model, effective budgets, duration, usage snapshots, automated approvals and scripted
user corrections (counted separately from actual human interventions). Costs are explicitly null without verified pricing. Usage
snapshots across a resumed run are cumulative and **must not be summed**. Separate
user-correction runs have their own snapshots. Contributor tooling uses Bun; the
normal package smoke independently checks the Node runtime.

Before any provider call, the fixtures and limits are fixed: 16 steps, 40 tool calls,
150 seconds, 60,000 input tokens, 8,192 output tokens and 68,192 total tokens per
invocation (durable resume additionally enforces the run budget). At most three
attempts may be declared before a campaign; default is one. Every selected fixture
must pass on its first attempt, no protected file may change, and no incomplete
run can pass. Retry recovery is reported separately and cannot erase first-attempt
failure. Missing credentials are recorded as blocked. Other failures retain a
sanitized diagnostic and remain failures.

```sh
bun run build
bun pm pack --ignore-scripts --filename /tmp/harness-candidate.tgz
# Edit a copy of evaluations/task-acceptance-routes.json to select explicit models.
# This command calls the selected providers and requires their configured credentials.
ZHIVEX_HARNESS_LIVE=1 bun --env-file=.env run evaluate:tasks \
  /tmp/harness-candidate.tgz /tmp/new-acceptance-report.json \
  evaluations/task-acceptance-routes.json
```

Use a new report path for every campaign. The report is reserved exclusively and
attempts are appended to its `.jsonl` journal before the next call. A setup error
or interrupted campaign cannot produce passing evidence. Default endpoints are
required for `direct-api`; proxy/hosted/Vertex certification needs its own explicit
route contract. Merely configuring a provider does not establish model access.

Fixtures first reproduce failure. Governed requests are limited to named files and
the exact test script. Before approval all implementation bytes must remain unchanged.
The final verifier is created outside the editable workspace and receives only
allowlisted regular implementation files and the original oracle. Completion text
and generated files cannot substitute for passing that independent check. Cancellation
has a different oracle: durable non-completion and unchanged implementation bytes.
The correction fixture preserves the original positive-currency tests while the independent oracle additionally checks symmetric rounding for negative refunds.

`bun test tests/task-acceptance.test.ts` runs every workflow against the real engine
with a deterministic model, including a deliberately incorrect implementation and
retry preservation. These tests validate the suite, not live providers. This suite
is small and synthetic, uses automated fixture approvals, and is not a security
sandbox, an independent human review, a competitive benchmark or protected release
certification. Existing historical representative matrices remain unchanged.
