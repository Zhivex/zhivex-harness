# Assistant task metrics and initial evaluations

Assistant records local task observations in `state/task-metrics.sqlite` (owner-only permissions). Recording is enabled for runs started through the shared local service, including web and Telegram conversations. The store belongs to Assistant and does not read or modify Harness database tables. It uses the public run store and durable usage ledger.

## Meaning of a task

Every new observed run initially owns one task, identified by its run ID. Approval/resume checkpoints update that run instead of adding another attempt. An operator can explicitly link a later run in the same session as a `continuation` or `correction`. The source must still be a single, unreviewed task. Linking removes the source from the task count; its run, duration and cost remain in the destination. Repeating the same link is idempotent. A correction counts one corrective run, not the number of messages or approval clicks. Ordinary follow-up messages are not automatically classified as corrections.

A runtime status of `completed` does **not** establish success. Tasks remain `unverified` until an operator records `success`, `failure` or `abandoned` against a current observation revision. Verify the actual Calendar state for writes, inspect delivery receipts for sends, and review answer correctness for read-only tasks. Feedback records operator judgment, not an automated external-state certification. Pending tasks cannot receive a final verdict. A changed run or newly linked correction invalidates an earlier verdict until reviewed again.

## Measurements

- `durationMs`: wall time from the first observed admission to the last terminal run update, including approval waits and gaps between linked runs. It excludes the later operator review time. Pending duration is `null`; `elapsedMs` remains available. This is not active compute time or human time saved.
- `corrections`: number of explicitly linked corrective runs.
- `inputTokens` / `outputTokens`: known durable usage, accompanied by `usageComplete`. Partial token totals must not be interpreted as complete usage.
- `estimatedUsd`: sum of the durable per-run estimates, including failed attempts. It is `null` unless every run is terminal and has complete usage and pricing. Streaming events are never summed with cumulative receipts. Route/model and missing/stale pricing statuses are retained when available.
- `estimatedUsdPerSuccess`: total estimated cost of **all** recorded tasks divided by verified successes. It is `null` if there are no verified successes or any task has unknown cost. The report includes verification coverage so success rates cannot silently hide unreviewed work.
- `verifiedSuccessRate`: verified successes divided by evaluated tasks, including failures and abandoned tasks. Unverified tasks are reported separately.

Costs are token estimates, not invoices. Tool-service fees, subscriptions and human labor are outside this metric. No numeric price is assumed. Prices are frozen by the Harness ledger for each run; changing configuration does not reprice prior runs. Missing, expired or incomplete usage remains unknown. A confirmed zero-call run may legitimately cost zero.

## Pricing configuration

Trusted embedding hosts can pass `taskMetricsPricing` to `startAssistantHost`. The CLI also accepts the same optional field in its `--config` JSON:

```json
{
  "schemaVersion": 1,
  "modules": [],
  "taskMetricsPricing": {
    "schemaVersion": 1,
    "prices": [
      {
        "provider": "example-provider",
        "model": "example-model",
        "inputUsdPerMillion": 1,
        "outputUsdPerMillion": 2,
        "source": "Example only: replace with your dated pricing source",
        "asOf": "2026-11-01T00:00:00Z",
        "expiresAt": "2026-12-01T00:00:00Z"
      }
    ]
  }
}
```

These are illustrative rates, not current vendor prices. Provider/model must match the actual route identity. Supply a dated source and validity interval. Pricing config is trusted host configuration; conversational messages cannot change it. The managed onboarding UI does not yet expose a price editor.

## Read, link and review

The trusted host API exposes:

```ts
const report = await host.taskMetrics.report();
const original = report.tasks[0]!;

// After a corrective run exists in the same conversation:
await host.taskMetrics.link({
  taskId: original.taskId,
  runId: correctiveRunId,
  kind: "correction"
});

const current = (await host.taskMetrics.report()).tasks
  .find(task => task.taskId === original.taskId)!;
await host.taskMetrics.feedback({
  taskId: current.taskId,
  expectedRevision: current.revision,
  outcome: "success",
  category: "calendar-change"
});
Use the shared application through Electron or the commands documented in [CLI](CLI.md). The standalone Assistant launcher has been retired.sh
bun test tests/assistant/evaluation.test.ts
# Use planAssistantEvaluation from the core to generate a plan.
```

Planning writes a new private file and refuses to overwrite an existing file. It creates 90 **not-executed** trials (three repetitions per case), a suite digest, configuration placeholders, and empty evidence/result fields. It makes no model calls and performs no external actions. This is a prepared evaluation protocol, not a live runner or benchmark result.

Before running trials:

1. Pin the product/artifact, provider/model, tool configuration, pricing source, time limit and task budget. Prepare controlled Calendar and Telegram accounts with no real recipients.
2. Reset fixtures and use a fresh session for every trial. Keep all repetitions and failures. Follow-up and correction turns inside a trial share one task.
3. Execute user turns through the actual product; operator turns perform fixture actions and inspect exact approvals. For clock/fault cases, use a deterministic driver or record equivalent controlled live setup.
4. Verify every listed check against independent state, delivery evidence or human review. Keep sanitized evidence references outside the model's context. Missing evidence means unverified. Record unsupported features distinctly.
5. Fill the planned trial fields, including the corresponding metrics task ID where applicable. Direct commands and scheduler cases require independently measured duration, result and any external cost; do not invent a model task ID or substitute missing cost with zero.

For competition, run a separately labeled full-product comparison and a matched-model/tools/budget comparison where possible. Alternate product order, preserve all results, and report per-category coverage, success, duration, corrections and cost. Three repetitions are a smoke assessment, not statistical evidence of superiority. Freeze a separate held-out set before tuning; these public scenarios are development fixtures. The existing coding-agent benchmarks do not measure Assistant product quality.
