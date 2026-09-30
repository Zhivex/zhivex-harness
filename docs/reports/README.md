# Historical reports

Internal working notes, diagnostic plans and intermediate investigations belong
in the Git-ignored `.local-docs/docs/reports/` directory at the repository root.
That local archive is not available in a fresh clone or in the published package.
Keep final acceptance, release, security and consolidated campaign evidence here,
along with any evidence referenced by maintained documentation or validation gates.

These reports preserve findings and measurements from specific checkouts and runs. Read each report's scope and limitations before reusing its claims. Local remediation does not certify a new published artifact or update an earlier model score. Maintained behavior is documented in the [documentation index](../README.md).

These source archives and their JSON evidence are excluded from the installed
package. Preserve failed attempts and source bindings here; user guides link to
this archive rather than bundling development journals. Personal paths in copied
upstream tracebacks are anonymized in this repository copy; evaluation outcomes
and recorded artifact hashes are unchanged.

## Archived audits and implementation notes

| Snapshot | Follow-up |
| --- | --- |
| [Harness audit — September 9](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/HARNESS_AUDIT_2026-09-09.md) | [Implementation and validation — September 9](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/HARNESS_REMEDIATION_2026-09-09.md) |
| [Architecture review — September 9](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/HARNESS_ARCHITECTURE_REVIEW_2026-09-09.md) | Subsequent [full review — September 10](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/FULL_HARNESS_REVIEW_2026-09-10.md) |
| [Full review — September 10](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/FULL_HARNESS_REVIEW_2026-09-10.md) | [Implementation, validation and remaining limits — September 10](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/HARNESS_REMEDIATION_2026-09-10.md) |

The five audit and remediation reports above are preserved at commit
`ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5` rather than duplicated in the working tree.
The [context efficiency implementation report](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/CONTEXT_EFFICIENCY_2026-09-22.md)
is archived at the same commit. Their findings, failed attempts and validation
limits remain historical; this cleanup does not change any outcome. Baseline
results remain in the repository. The same local Git commit preserves the linked
files independently of remote availability.

Five intermediate diagnostic plans were also removed from the working tree.
Their source hashes, budgets and stop rules remain in the
[archived evidence directory](https://github.com/Zhivex/zhivex-harness/tree/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/evidence):

- `ga-plan-reserve-plan-2026-09-19.json`
- `ga-python-origin-delivery-plan-2026-09-19.json`
- `ga-qwen-patched-package-plan-2026-09-19.json`
- `ga-qwen-published-plan-2026-09-19.json`
- `ga-required-delivery-live-plan-2026-09-19.json`

The corresponding result JSON files remain here, including unsuccessful outcomes.
Release, security, acceptance and benchmark evidence remains in the working tree.

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

## Archived candidate preparation and design material

The nine 1.1.0 RC.1–RC.9 preparation notes are preserved in the
[release-note archive](https://github.com/Zhivex/zhivex-harness/tree/d3d059f3259b46e58724f9de3503b7dcb5c28a5e/docs/releases).
Their pending states and recorded failures describe those historical candidates.
For maintained release procedures and evidence, use [Release](../RELEASE.md) and
[Live certification](../LIVE_CERTIFICATION.md).

The exploratory rebranding analysis, concepts and screenshots are preserved in
the [design archive](https://github.com/Zhivex/zhivex-harness/tree/d3d059f3259b46e58724f9de3503b7dcb5c28a5e/output/ux-rebranding).
Both archives remain available in that local Git commit independently of remote
availability. Removing their working-tree copies does not change validation outcomes.

## RC4 acceptance and archived intermediate narratives

Use the [RC4 readiness report](HAR_1_3_RC4_PR_READINESS_2026-09-29.md) and its
[JSON evidence](HAR_1_3_RC4_PR_READINESS_2026-09-29.json) for the final local candidate.
The [final comparative pilot](HAR_HU_51_FINAL_CAMPAIGN_2026-09-29.md) retains its original artifact identity.

Nine superseded readiness and intermediate campaign narratives were removed from
the working tree. Their original content remains in Git history at the links below.
All result JSON files, including unsuccessful attempts, remain in this directory.
This cleanup changes no evaluation outcome or certification scope.

- [HAR_1_3_DEPLOYMENT_READINESS_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_1_3_DEPLOYMENT_READINESS_2026-09-29.md)
- [HAR_HU_45_CURRENT_CANDIDATE_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_45_CURRENT_CANDIDATE_2026-09-29.md)
- [HAR_HU_45_FINAL_CANDIDATE_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_45_FINAL_CANDIDATE_2026-09-29.md)
- [HAR_HU_45_GEMINI_RECHECK_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_45_GEMINI_RECHECK_2026-09-29.md)
- [HAR_HU_45_REMAINING_ROUTES_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_45_REMAINING_ROUTES_2026-09-29.md)
- [HAR_HU_51_CONTEXT_CAMPAIGN_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_51_CONTEXT_CAMPAIGN_2026-09-29.md)
- [HAR_HU_51_CONTEXT_GUARDED_CAMPAIGN_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_51_CONTEXT_GUARDED_CAMPAIGN_2026-09-29.md)
- [HAR_HU_51_SONNET_55_FIRST_CAMPAIGN_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_51_SONNET_55_FIRST_CAMPAIGN_2026-09-29.md)
- [HAR_HU_51_SONNET_55_SYSTEM_CAMPAIGN_2026-09-29.md](https://github.com/Zhivex/zhivex-harness/blob/5e4f64d401a13b9cf993d72596c3c4d89bc1128c/docs/reports/HAR_HU_51_SONNET_55_SYSTEM_CAMPAIGN_2026-09-29.md)

- [RC4 dependency update](HAR_RC4_DEPENDENCY_UPDATE_2026-09-29.md): updated SDK/tooling validation, excluded compiler API update, CI fixture fixes and preserved live failures.
