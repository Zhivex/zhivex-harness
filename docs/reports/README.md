# Historical reports

These reports preserve findings and measurements from specific checkouts and runs. Read each report's scope and limitations before reusing its claims. Local remediation does not certify a new published artifact or update an earlier model score. Maintained behavior is documented in the [documentation index](../README.md).

These source archives and their JSON evidence are excluded from the installed
package. Preserve failed attempts and source bindings here; user guides link to
this archive rather than bundling development journals. Personal paths in copied
upstream tracebacks are anonymized in this repository copy; evaluation outcomes
and recorded artifact hashes are unchanged.

## Audits and remediation

| Snapshot | Follow-up |
| --- | --- |
| [Harness audit — September 9](HARNESS_AUDIT_2026-09-09.md) | [Implementation and validation — September 9](HARNESS_REMEDIATION_2026-09-09.md) |
| [Architecture review — September 9](HARNESS_ARCHITECTURE_REVIEW_2026-09-09.md) | Subsequent [full review — September 10](FULL_HARNESS_REVIEW_2026-09-10.md) |
| [Full review — September 10](FULL_HARNESS_REVIEW_2026-09-10.md) | [Implementation, validation and remaining limits — September 10](HARNESS_REMEDIATION_2026-09-10.md) |

The follow-up documents record implementation evidence; retain the original reports and baseline JSON files for traceability.

## Efficiency and model comparisons

- [Efficiency implementation evidence](EFFICIENCY_REVIEW.md): September 8 work and subsequent recorded checks; SDK versions refer to those snapshots.
- [External comparison](EXTERNAL_COMPARISON.md): accumulated experimental cohorts and their limitations.
- [Model comparison — September 9](MODEL_COMPARISON_2026-09-09.md): frozen model comparisons and recovery studies.
- [Qwen reevaluation — September 9](QWEN_REMEDIATION_COMPARISON_2026-09-09.md): results after the then-current remediation, followed by structural findings.

Protocols remain in the [benchmark guide](../../benchmarks/README.md) and [Time-to-Safe-Fix guide](../TIME_TO_SAFE_FIX.md). Each report links its preserved baseline evidence.

## Release validation

- [HAR-HU-12 stable onboarding — September 20](HAR_HU_12_2026-09-20.md): published 1.0.0 installation, version/help/doctor, documentation guards and evidence limits.

- [RC14 validation and publication hold — September 10](RC14_VALIDATION_2026-09-10.md): new live cohort, frozen source identity, validation boundaries and conditions to resume publication.

## Consolidated desktop acceptance and archived working notes

- [Acceptance audit, September 21](HAR_HU_13_35_ACCEPTANCE_AUDIT_2026-09-21.md) and [criterion-level evidence](HAR_HU_13_35_ACCEPTANCE_AUDIT_2026-09-21.json) preserve the final HU13–35 assessment and its limits. These are dated snapshots, not current user guides.
- [Desktop guide](https://github.com/Zhivex/zhivex-harness/blob/main/desktop/README.md) documents current setup, behavior and validation commands.
- [RC13 dossier](security/RC13_SECURITY_REVIEW.md) and [RC14 dossier](security/RC14_SECURITY_REVIEW.md) retain the preparatory drafts separately from the final review in `security-reviews/rc14-review.json`.

Incremental HU plans, component reports and screenshots were consolidated out of
the working tree. Their original bytes and the paths cited by the frozen acceptance
JSON remain available in the [pre-cleanup report tree](https://github.com/Zhivex/zhivex-harness/tree/c94a6c1cff9d6cbf0a3c66c05f7ce16df1d3cc38/docs/reports).
The same local Git commit preserves them before this branch is pushed.

SDK patch proposals and PR drafting material belong to SDK development. Their
[original patches and evidence](https://github.com/Zhivex/zhivex-harness/tree/c94a6c1cff9d6cbf0a3c66c05f7ce16df1d3cc38/upstream-fixes)
are preserved in Git history, including any proposals not yet integrated upstream;
removing the copies from this checkout does not assert that they were merged.
The UI reference capture and transient redesign QA assets are likewise retained
in that commit. Release, security, benchmark and unsuccessful evaluation evidence
remain in this archive; this cleanup does not change their results.

Transient September 22–23 provider and SDK investigation notes and their local
trial JSON were removed before RC.10. They remain available in the
[pre-cleanup report tree](https://github.com/Zhivex/zhivex-harness/tree/dbf0d47/docs/reports).
Their removal does not change failed outcomes or certify the next candidate.
