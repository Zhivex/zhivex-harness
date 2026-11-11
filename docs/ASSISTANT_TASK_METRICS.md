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
```

The local web server exposes equivalent endpoints under the existing private bearer token and same-origin checks:

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/api/task-metrics` | Versioned report with tasks and aggregate summary |
| POST | `/api/task-metrics/link` | `{ taskId, runId, kind: "correction" \| "continuation" }` |
| POST | `/api/task-metrics/feedback` | `{ taskId, expectedRevision, outcome, category }` |

POST requires the local web origin and `Content-Type: application/json`. Invalid schemas return 400; stale reviews, pending tasks, missing references and invalid links return 409. These endpoints do not grant approval to any tool operation. Feedback and grouping currently use the API; no new dashboard or conversation controls are included.

Categories: `general`, `agenda`, `calendar-change`, `preferences`, `daily-summary`, `recovery`. Category assignment is explicit; prompts are not analyzed or retained by the metrics store.

## Evidence boundary and privacy

The metrics database retains IDs, timestamps, statuses, numeric consumption, route/model identifiers, categories and review outcomes. It does not retain prompts, responses, event titles, tool arguments, credentials or arbitrary feedback text. It is not uploaded. Existing conversation storage has its own separate retention behavior. Reports contain stable local IDs and should be treated as private; retaining the database retains these observations.

On startup and report reads, recorded runs are reconciled from public durable state. Existing historical sessions are not automatically imported. An observation without a recoverable state stays uncertain instead of being assigned an invented completion. Reports may include active work; wait for a quiescent host before exporting a benchmark result.

This first instrumentation covers **conversation runs**, not direct `/memory` or `/daily` command handling, agenda-page reads, or deterministic scheduled deliveries. Those bypass the model run path. Their cases are included in the evaluation battery but require separate driver observations. Never count a scheduled send as user engagement, or infer delivery success from a completed conversation run.

## Initial evaluation battery

`packages/assistant/evaluations/tasks.v1.json` defines 30 English scenarios across agenda reads, approved/rejected/stale calendar changes, corrections, explicit preferences, daily delivery, recovery, and untrusted event content. Each case specifies setup, operator/user turns, verification method and required checks. The shared fixture clock and timezone are explicit.

```sh
bun run --cwd packages/assistant eval:tasks --validate
bun run --cwd packages/assistant eval:tasks --plan /tmp/assistant-evaluation-plan.json
```

Planning writes a new private file and refuses to overwrite an existing file. It creates 90 **not-executed** trials (three repetitions per case), a suite digest, configuration placeholders, and empty evidence/result fields. It makes no model calls and performs no external actions. This is a prepared evaluation protocol, not a live runner or benchmark result.

Before running trials:

1. Pin the product/artifact, provider/model, tool configuration, pricing source, time limit and task budget. Prepare controlled Calendar and Telegram accounts with no real recipients.
2. Reset fixtures and use a fresh session for every trial. Keep all repetitions and failures. Follow-up and correction turns inside a trial share one task.
3. Execute user turns through the actual product; operator turns perform fixture actions and inspect exact approvals. For clock/fault cases, use a deterministic driver or record equivalent controlled live setup.
4. Verify every listed check against independent state, delivery evidence or human review. Keep sanitized evidence references outside the model's context. Missing evidence means unverified. Record unsupported features distinctly.
5. Fill the planned trial fields, including the corresponding metrics task ID where applicable. Direct commands and scheduler cases require independently measured duration, result and any external cost; do not invent a model task ID or substitute missing cost with zero.

For competition, run a separately labeled full-product comparison and a matched-model/tools/budget comparison where possible. Alternate product order, preserve all results, and report per-category coverage, success, duration, corrections and cost. Three repetitions are a smoke assessment, not statistical evidence of superiority. Freeze a separate held-out set before tuning; these public scenarios are development fixtures. The existing coding-agent benchmarks do not measure Assistant product quality.
