# Review a small task in Code

This workflow is an unreleased experimental CLI addition. Published Code 0.2.0
and 0.3.0-rc.1 do not have `/task`. Use the candidate artifact prepared by your
operator; this document does not authorize publishing RC.3 or changing npm tags.

Start in a clean Git repository with a working package check. Selected files must
remain visible to Git diff: ignored untracked files and files marked
`skip-worktree` or `assume-unchanged` are rejected at start and keep. Prepare a separate
Git worktree yourself if your checkout contains changes you want to preserve.
Code never stashes, resets, commits or pushes your files automatically.

```text
/task start {"goal":"Fix greeting punctuation","paths":["greeting.mjs"],"checks":["test"],"constraints":["Keep the named export"],"budget":{"inputTokens":60000,"outputTokens":8192,"totalTokens":68192}}
Fix greeting punctuation and run the declared check.
/task review
/task keep
```

`start` inspects the baseline, establishes its persistent budget authority and
saves a bounded task draft in the existing engine store. It survives exit even
if the first request is refused before a run checkpoint exists. The first
submitted request binds the goal, constraints, baseline digests and exact check
contract to its execution run. A draft is a control record, not a model run.
The first slice supports the native backend, without subagents, 1–20 selected
existing Git-tracked text files (at most 64 KiB of source bytes each), and 1–8
allowlisted package scripts. `package.json` is protected from reviewed edits.
Checks still require the selected approval policy; the default asks before effect.

During a guided task, reviewed edit tools can only write the exact declared paths.
Other effect tools, undeclared checks and delegation are unavailable. This does
not isolate command execution: approved package scripts run on your host and can
access it. Use a trusted repository. Native verification covers selected files,
declared protected files and `package.json`, not the entire dependency tree or
all repository files. OCI keeps its separate snapshot/import guarantees.

Run completion and task evidence are separate. Every required check must have a
host-observed exit-zero receipt, no timeout, and unchanged watched file digests
before and after the command. A later edit invalidates earlier evidence. Missing,
failed, uncertain or stale receipts leave the task incomplete. Passing checks
leave human review pending; they do not prove the goal or subjective constraints.

`/task review` displays the retained goal, constraints, task budget, receipts, human decision,
fresh Git diff and any drift in watched files. Reopening the conversation displays
the same recap. `/task keep` checks freshness, shows a fresh review and asks you to
type `keep`. It records your decision for that run and snapshot with a revision
check. File or Git-diff changes during review block the decision. Keeping is
an acknowledgment; use your normal Git workflow to export a patch or commit.

```text
/task revise Keep the punctuation but handle an empty name too.
```

`revise` appends a bounded constraint and starts a new turn with the same task
goal and file scope. It clears the previous keep decision and requires fresh
checks. A normal new request in a guided conversation also starts fresh evidence;
old receipts are never carried to a different run. Use `/new` for another task.
`/clear` clears conversation context, while the current task requirements remain.
The existing `/checkpoint` restore workflow is separate, explicitly reviewed and
limited to its documented file coverage; there is no automatic rejection/undo.

For automation, `run`/`resume` JSON includes `verification` with redacted
recorded-check receipts and counts. `runs inspect` and `runs export` retain this
projection from completed journal entries. It omits argv and command output and
always says `taskVerified: false`: generic check receipts are observations, not a
task contract or human acceptance. Existing run status and exit codes are unchanged.
`/task` is currently available in direct CLI chat; service chat and web do not yet
offer this guided workflow.

The task's budget authority spans new turns, `/task revise`, `/continue` and
process restarts. Those operations do not replenish its budget. `/usage` reports
the authoritative task account in addition to the latest run's receipts. Requests,
retries and model compaction reserve and charge the same account; unknown usage
remains held and blocks further admission instead of being counted as free.
USD figures are operator estimates, not invoices or guaranteed provider charges.
Changes to `/budget` apply to future tasks; the current task retains the policy
established at start. Use `/new` and `/task start` to establish another task.
Guided tasks enable finite configured token ceilings, including when ordinary
chat uses unlimited tokens. The recap shows the ceilings established at start.
Legacy saved tasks without an established authority remain available for review,
but require an explicit new task before further model calls.

During a guided task, `/review` displays the same local evidence and Git diff as
`/task review`. It does not start reviewer agents. `/connection` tests require
a separate conversation because every guided-task model call must use its task
budget authority.

Task authority currently requires the native single-writer SQLite host and a
vetted built-in transport. Direct Code tasks support OpenAI, Anthropic, Gemini
and Vertex. Direct Qwen tasks lack explicit Chat-mode admission and are blocked;
Meta and arbitrary custom transports are also blocked in this opt-in flow.
See the [Harness CLI guide](../../../docs/CLI.md) for the transport contract.
Cancellation requests cooperative stopping and retains any unresolved prior
invocation. A new run cannot take over while that invocation is pending, even
when its token receipts are complete. Complete late usage remains charged.

## Reproducible offline demonstration

Use the installed `examples/first-use.mjs` tutorial. Its model responses and token
counts are synthetic; edits, approvals, checks, Git review and persistence are real.
Start it in a disposable directory. Before the minute, create a Git baseline there
and ignore `.zhivex-harness/` and `.tutorial*`; never do this in a user's checkout.
The tutorial's test initially fails, so the check demonstrates an actual correction.

In the console, submit `/task start` with goal `Fix greeting`, path `greeting.mjs`,
check `test`, and constraint `Keep the named export`. Submit `Fix greeting`; review
and approve the edit, then review and approve the test. Show `pending_review` and
the exit-zero receipt, run `/task keep`, review and type `keep`. Exit and reopen;
show the retained goal, constraint, receipt and human decision. These operations
form a prepared 60-second demonstration; exact elapsed time is not certified.
The installed PTY journey also changes a file externally, proves keep is blocked,
and revises the task to show an actual failed check leaving it incomplete.

Interactive no-cap hosts require the explicit `budget` object shown above. It belongs only to this TASK; ordinary chat defaults remain unchanged. On reopen/revise the original frozen task limits and monetary owner remain authoritative. Task review distinguishes confirmed estimates, reservations, unknown exposure held and late receipt counts; none is an invoice.
