# Correction verification — 2026-09-19

**All four reproduced findings pass local acceptance. GA remains NO-GO.**
Evaluator: Codex, automated technical review delegated by the operator.
This document supplements the original decision; it is neither a human signature nor
certification of a published artifact.

Subject: uncommitted local changes on `28723ff3350b7572d5bd68f2d40b6feef1e0e6b4`,
version `1.0.0-rc.14`, including the checkout dependency update.
The [structured evidence](../docs/reports/evidence/security-remediation-2026-09-19.json)
identifies files by SHA-256 and preserves acceptance results.

| Finding | Correction and acceptance |
| --- | --- |
| SEC-04, high | OCI identity bound to workspace, state and full scope; metadata, runtime and patch use that identity. No cross-scope reading through `runHarness`; every scope dimension has isolation, resume, import and cleanup regressions. Scopeless legacy state is rejected. |
| SEC-01, medium | Writer exclusion through SQLite outside the repository, including import and rollback. Only one update accepts the shared digest; cross-process, dead-owner and concurrent OCI import regressions pass. |
| SEC-02, medium | `apply_reviewed_replacement` shows full content in the default review; new text remains visible even with long old text. |
| SEC-03, low | Inventory includes `read_task` and `repair_plan`; parity now queries their actual tools. |

Validation: 519 full-suite tests without failures; the concurrent-import
regression was then added and its 30 OCI/workspace tests passed.
Types, documentation, preparation contracts, migrations, evaluations,
deterministic benchmarks, both MCP smokes and real Docker passed. The installed-package
smoke detected different TS6/TS7 declaration emitters; it was corrected to
use the build compiler and passed on repeat, together with all three signature
tests. `bun audit` finished with no vulnerabilities reported in 35 packages.

Updating to Core 1.20.0 resolves dependency incompatibility with
Agents 1.8.0. TypeScript 7 compiles; the TypeScript 6 alias is limited to its Compiler
API for signature analysis. The signature snapshot was regenerated for declaration
and policy changes; matching alone does not establish absence of
semantic dependency changes.

Limitations: locking coordinates Harness writers on Linux/macOS, not arbitrary
programs under the same user or atomic multi-file writes during power
loss. Host, daemon and image remain trusted. Snapshot migration
is documented in `docs/EXECUTION_ENVIRONMENTS.md`; old scopeless state
is not adopted. Execution contracts and paused approvals change
deliberately with the new policy.

Pending for GA:

1. Demonstrate reliable delivery after recovery changes. GA-01 already has a
   correction and two-turn regression for all three providers, documented
   in [budget remediation](../docs/reports/GA_BUDGET_REMEDIATION_2026-09-19.md).
   Development series v3 resolved 1/3 cases with OpenAI and 0/3 with Qwen, versus
   3/3 per provider for the control. This does not satisfy GA acceptance.
2. Repeat live certification and representative/holdout cohort on the corrected
   candidate; historical results do not certify these changes.
3. Obtain protected CI and release, immutable artifact, publication and provenance;
   review that final candidate and satisfy the formal GA gate.

This checkout was not published, tagged or declared GA.

Local update: the preceding corrections landed in commit
`41bd1cb4ab8481a7413f096a0817f612fe9806fe`. The subsequent verifier-diagnostic
review and tests remain in the working tree. All four adversarial
tests and the stale-digest control pass again; the current full suite
has 533 passing tests. Diagnostics are delivered only as untrusted
tool results, redacted and limited to 2048 characters per channel;
generic errors and telemetry projection still omit them. Pattern-based redaction
does not guarantee removal of every business datum printed by an approved
command. This is neither live acceptance nor final-artifact review.

## Current candidate revalidation

On commit `c2b2bb917d0471e61afc5f731a61c00b44fa3731`,
`bun run scripts/validate-security-review.ts` again exits with code 0:
SEC-01, SEC-02, SEC-03, SEC-04 and the stale-digest control pass.
The [current evidence](../docs/reports/evidence/security-current-2026-09-19.json)
preserves results and source hashes. Subsequent corrections
previously described as working-tree changes are now included in this commit.

Decision: all four known findings are corrected in local
acceptance. This does not establish absence of other defects or constitute a human signature.
The full suite recorded for this candidate has 555 passing tests;
the new execution documented here is focused adversarial acceptance.

GA remains NO-GO. Development series v8 obtained Harness 0/1 versus control
1/1 with Qwen; reliable delivery, an SDK correction published and
consumed by the candidate, representative cohort and fresh holdout, protected CI/release
and final artifact review remain pending. See the
[recovery report](../docs/reports/GA_REPAIR_RECOVERY_2026-09-19.md).
