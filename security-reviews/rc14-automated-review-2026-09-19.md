# RC.14 security decision — 2026-09-19

**Technical review completed. Decision: NOT APPROVED for GA.**

Evaluator: **Codex, automated review**, explicitly delegated by the operator.
Delegated trust enables this technical decision; it does not make the evaluator
a person or this document a human attestation. No signature is requested
to continue the identified corrections.

Subject: commit `28723ff3350b7572d5bd68f2d40b6feef1e0e6b4`, version
`1.0.0-rc.14`. An isolated export with its exact lockfile was reviewed;
concurrent dependency changes in the original checkout are excluded.
The [JSON record](rc14-automated-review-2026-09-19.json) contains source
and local artifact hashes, per-item coverage, residual risks and results.

## Confirmed findings

### SEC-04 — High: OCI snapshots shared across different scopes

In [execution-environment.ts](https://github.com/Zhivex/zhivex-harness/blob/28723ff3350b7572d5bd68f2d40b6feef1e0e6b4/src/execution-environment.ts), acquisition
selects `environments/<hash(runId)>`. Metadata checks run, workspace and image,
but not `tenantId`, `userId` or `namespace` (lines 1633–1650 of the reviewed commit).
Environment identity does not incorporate these fields either.

**Reproduction:** two different scopes, same workspace, state directory and
`runId`. The first scope leaves a private file in its pending snapshot. The
second calls public API `runHarness` and `read_file`: it obtains that file
and completes the run. Only image inspection is simulated; acquisition,
metadata, snapshot, persistence and tool execution are real. No containers
or provider calls run and all data is fixtures.

**Impact:** breach of confidentiality and integrity of per-scope run isolation
when IDs coincide. The application can supply runId; no cryptographic
collision is needed. The test demonstrates cross-scope reading, not
container escape, unapproved host import or access to another machine.
Automatically generated UUIDs reduce accidental collisions but are not
a tenant-isolation control. Import and cleanup impact must be
covered when fixing the shared identity.

**Required correction:** canonical workspace + full scope + run identity
in directories, metadata, runtime resources, patch and cleanup. Reject or explicitly
migrate old scopeless artifacts. Add cross-tenant read/resume,
import, cancellation and cleanup regressions with the same ID, preserving
legitimate same-scope resume. Until then, do not share OCI state directories
across scopes; that operational mitigation does not close the finding.

### SEC-01 — Medium: two incompatible writes accept the same digest

In [workspace.ts](https://github.com/Zhivex/zhivex-harness/blob/28723ff3350b7572d5bd68f2d40b6feef1e0e6b4/src/workspace.ts), the last digest check and `rename`
are separated by asynchronous operations, including `assertActive`
(lines 1226–1232). There is no workspace mutual exclusion between the two writers.

**Reproduction:** two `Workspace` instances update the same file from
the same digest to different contents. A barrier at the public checkpoint
before publication causes both to validate before renaming: both return
success and one overwrites the other. An additional uninstrumented test
reproduced double acceptance in 18 of 20 attempts. The sequential stale-write
control was correctly rejected.

**Impact:** lost update and stale approval precondition.
Per-run leases do not coordinate two different runs over the same file.
No approval bypass or out-of-workspace write was demonstrated.

**Required correction:** serialize mutation transactions across runs
and processes, with ownership recoverable after failures, validation inside the
protected section and rollback that does not overwrite others' changes. Acceptance
requires exactly one success and one conflict for two incompatible updates,
including concurrent OCI imports.

### SEC-02 — Medium: replacement approval hides new text

[terminal-ui.ts](https://github.com/Zhivex/zhivex-harness/blob/28723ff3350b7572d5bd68f2d40b6feef1e0e6b4/src/terminal-ui.ts) omits `apply_reviewed_replacement` from
`EXACT_REVIEW_TOOLS` (lines 9–22). With a 2,000-character `oldText`,
the default card truncates before showing `newText`.

**Impact:** a built-in mutation can be approved without seeing the replacement
that will execute by default. An omission notice and full view through `v` exist;
this limits severity and does not constitute silent execution.

**Required correction:** include the tool in the full-review set
and comprehensively test all catalog mutations. Preserve
terminal control-sequence escaping.

### SEC-03 — Low: incomplete security inventory

[security-review-evidence.ts](../scripts/security-review-evidence.ts) does not enumerate
`read_task` or `repair_plan`. Its parity test also omits
`createTaskTools`, so it passes despite missing both tools.

**Impact:** the gate can declare coverage complete without including original-request
reading or controller verifier selection.
Inspection of these tools showed no direct command authorization;
the verifier still requires approval. The defect concerns coverage.

**Required correction:** compare the inventory with the actual complete catalog,
update the record and demonstrate that removing either class
breaks the test. Both are already evaluated in this review's JSON.

## Coverage and evidence

Targeted inspection covered **10 controls, 11 boundaries and 31 tool
classes**, including RC.14 additions. Each JSON row identifies
inspected code, relevant evidence, findings and limitations. No line-by-line
audit of all transitive dependencies is claimed.

- **152/152** focused tests for security, editing, MCP, context, profiles,
  state, sessions, OCI, orchestration, backups and review contract.
- **51/51** additional tests for terminal, input/attachments, verifier
  recovery, workflow and release provenance.
- New adversarial acceptance: four confirmed failures and a positive control
  rejecting a stale digest. Tooling types: PASS.
- Evidence from [earlier GA validation in this same session](../docs/reports/GA_VALIDATION_2026-09-19.md)
  is preserved: 512 tests, real OCI and an exact-tarball consumer passed. None of these
  results invalidates the new findings.

Reproduction without credentials or network, with the reviewed commit's dependencies:

```sh
bun run scripts/validate-security-review.ts
```

Expected output from the defective candidate: code **1**, `SEC-01`, `SEC-02`,
`SEC-03` and `SEC-04` with `passed: false`. The program creates and deletes only temporary
fixtures. Results apply to the isolated baseline, not dependencies
being updated in parallel.

## Preserved controls and limitations

Inspected controls include descriptor-based reads without following links,
path and sensitive-file restrictions, digest-bound proposals, durable
approvals and verifier recovery. OCI: networking disabled, read-only
root, dropped capabilities, resource limits, snapshot validation and
separate import. MCP retains permissions, limits and JSON-RPC identity;
prompt-injection expressions are a heuristic, never a guarantee.

Explicit service configuration, the application process, the operator
account, kernel and daemon remain trusted by design. The backend
without OCI executes approved checks on the host. Redaction does not detect every
possible secret; the provider sees the context sent to it. A verifier
exiting 0 does not by itself prove requirements are met.

No current dependency audit was obtained: npm returned HTTP 503.
Workflow and verifier review does not establish a publication that does
not yet exist. RC.14 still lacks final protected release/SLSA evidence.

## Decision and next work

There are **1 high, 2 medium and 1 low open findings**, with no critical findings identified.
These count what was found, not a guarantee of no other defects.
SEC-04 blocks security approval; it must not be accepted merely as residual
risk. This record uses an explicit automated source-review type,
distinct from JSON attesting an approved published release.

Next: fix **SEC-04 → SEC-01 → SEC-02/03**, preserve these
reproductions as regressions and review the resulting candidate again.
Then GA-01 (budget), repair-delivery hold,
audit/CI and protected artifact/live/representative-matrix certification remain.
Completion must bind to final candidate bytes and commit.

Runtime, dependencies, policy and ledger were not modified to declare
approval. Original concurrent changes were preserved.
