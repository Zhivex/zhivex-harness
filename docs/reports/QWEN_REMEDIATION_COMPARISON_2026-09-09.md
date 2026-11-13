# Qwen reevaluation after Harness improvements — 2026-09-09

> Historical snapshot: findings and outcomes apply to the checkout and attempt
> recorded below. For the subsequent stable release outcome, see
> [current release evidence](../maintenance/LIVE_CERTIFICATION.md#current-public-status).
> Later publication does not change failed evaluation results.

> Historical snapshot: versions, findings and measurements below describe the recorded run, not the current checkout. See the [report index](README.md) for follow-up work and the [documentation index](../README.md) for maintained guides.

The [subsequent structural review](https://github.com/Zhivex/zhivex-harness/blob/ca3c3e85df8de39d0df325ff81a3b10c8c08d3b5/docs/reports/HARNESS_ARCHITECTURE_REVIEW_2026-09-09.md)
compares these traces with the controller and adds offline reproductions of
pending problems. It does not modify this run's frozen results.

Zhivex finished with **0/10 delivered repairs**, versus **4/10 for
mini-SWE-agent**. Improvements did not raise the final rate over the previous
run (0/5 versus 2/5). Independent capture detected three correct
Zhivex patches left unverified and unimported when the budget
ran out. They count neither as final successes nor as improvement over a
previous measurement that did not capture this data.

## Design and evidence

- Requested model: `qwen3.8-flash`, Qwen provider, international DashScope
  endpoint, Chat Completions, thinking disabled for both candidates.
- SWE-bench Verified, revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`:
  five known tasks, two repetitions per candidate, twenty attempts.
  This is a development reevaluation, not a fresh holdout or twenty independent
  tasks. It supports neither general superiority claims nor causal isolation
  of each improvement's effect.
- Harness `1.0.0-rc.13`, Core `1.14.0`, Agents `1.4.0`, Qwen `0.11.4`;
  mini-SWE-agent `2.4.6`, SWE-bench evaluator `4.1.0`.
- Limits: 24 steps, 2,048 output tokens per response, 100,000 cumulative input,
  16,000 cumulative output, 300 seconds, 2 CPUs and 2,048 MiB.
  The cumulative limit is checked between requests and can be exceeded by one
  response. Tool and step limits are not identical between loops.
- Both use identical task images, without container networking.
  Zhivex uses a read-only root, `/workspace`, automatic operator approvals
  and verification/import finalization; mini retains its loop and
  writable `/testbed`. The repair profile limits OCI output to 20,000 bytes;
  the mini adapter truncates at 100,000 characters. These differences are declared.
- Preflight passed on five images without model calls. Twenty unique
  samples, none missing and no evaluation failures. Complete usage in
  all twenty. All 60 source hashes match the checkout and archived
  copy at completion: runtime was not modified during comparison.

The [public baseline](../../benchmarks/baselines/external-qwen-remediation-2026-09-09.json)
preserves configuration, hashes, metrics and sanitized diagnostics. Patches,
predictions and official logs remain in the ignored local directory
`results/swebench/qwen-remediation-2026-09-09/`.

## Results

| Task | Zhivex final | Zhivex correct candidate | Mini final |
| --- | ---: | ---: | ---: |
| sympy-21930 | 0/2 | 0/2 | 0/2 |
| scikit-learn-10908 | 0/2 | 1/2 | 2/2 |
| django-15554 | 0/2 | 0/2 | 0/2 |
| scikit-learn-14141 | 0/2 | 2/2 | 2/2 |
| django-11265 | 0/2 | 0/2 | 0/2 |
| Total | **0/10** | **3/10** | **4/10** |

Candidate capture worked in all twenty attempts; capturing an empty
candidate does not mean producing a patch. Zhivex produced three nonempty candidates,
and all three passed independent evaluation. Mini produced eight nonempty candidates and
four passed. The final per-task difference is −40 percentage points;
the report's exploratory bootstrap interval is [−80, 0], with only five
tasks as resampling units.

| Metric (10 attempts per candidate) | Zhivex | Mini |
| --- | ---: | ---: |
| Input tokens | 943,192 | 734,184 |
| Output tokens | 10,327 | 12,184 |
| Model calls | 117 | 133 |
| Median driver duration | 36.51 s | 41.50 s |
| Budget exhaustion | 9 | 4 |
| Other terminal failure | 1 | 0 |

The median includes failures and excludes the external evaluator; it does not demonstrate
faster solving. There is no time-to-successful-repair for Zhivex. No pricing
was supplied: USD cost and cost per solution remain unknown.
The previous run had incomplete Zhivex usage and one repetition; token savings
cannot be inferred by comparing its totals with these results.

## What still fails in Harness

**Finalization lacks an effective reserve.** Nine attempts entered
finalization mode, but there were zero broad-call blocks and zero phase
blocks. None requested Harness verification. All three correct patches
stayed inside the execution environment; subsequent evaluation is only
diagnostic and does not replace approval, verification or import.

In scikit-learn-10908 repetition 2, governed editing finished at 74.23 s;
the agent continued requesting commands and ended with 102,299 input tokens.
In scikit-learn-14141, governed edits finished at 41.78 and 21.98 s,
but no transition to verification occurred before cutoff either. There is capacity
to solve these cases; it still needs to become delivery within budget.

**The added catalog consumes context on every request.** Tool definitions
increased from 6,629 to 8,995 characters (+35.7%); system plus catalog
increased from 11,157 to 13,755 (+23.3%). Mean tool results present
per request fell from 10,225.85 to 9,486.09 characters (−7.2%), over 66 and 117
requests respectively. These measure serialized characters, not
billed tokens or a controlled ablation. Memory and planning aids
have a fixed cost that must be measured against their benefit.

Next interventions to validate:

1. Reserve budget for verification/import and make the post-edit transition
   explicit while preserving permissions and integrity checks.
   Reserve must account for the next request and catalog size;
   rejecting only broad searches is insufficient.
2. Expose a small catalog per phase, preserving tools needed
   to correct a repair or verification failure. Measure actual token
   reduction and its effect on delivered solutions.
3. Adjust compaction and history using full request cost, and
   reduce exploration continuing inside approved shell commands.
4. Compare these variants separately in the development cohort, then
   evaluate a fresh cohort without changing the metric to count undelivered
   candidates. This run does not include those future interventions.

## SDK finding and user story

One SymPy attempt failed after a response with an unregistered tool.
The exact name was absent from sanitized diagnostics, so no specific
name is attributed to that call. Offline reproduction with Core 1.14.0 shows
that the model returns usage (100 input, 10 output), but durable state ends
failed with zero steps, zero results and missing usage. Harness middleware
did preserve the live attempt's 4,132 input tokens.

Created and verified in the Zhivex area, priority High, status Not started:
[SDK-HU — Preserve usage and diagnostics for unregistered tools; bounded explicit recovery](https://app.notion.com/p/3d7777b104f681248ed3cecffe9328d2).

Loss of durable usage/diagnostics is the reproduced defect. Unknown-tool
recovery is an optional feature request: the earlier argument-validation
HU did not include that case. Executing unknown tools,
remapping names or bypassing approvals is not proposed.

Reproduction without networking, with zero tool executions:

```sh
bun --no-env-file run evaluations/audits/sdk-unknown-tool-2026-09-09.ts
```

`../../evaluations/audits/sdk-unknown-tool-2026-09-09.ts` (source checkout) passed independent
typecheck. Report and baseline were validated against all twenty samples
and frozen hashes. No new paid matrix, publication or
runtime change was performed as part of closing this reevaluation.
