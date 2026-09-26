# Context engineering

Zhivex Harness `0.11.x` can load bounded project instructions without turning repository content into a way around harness policy.

## Discovery and precedence

Project context is enabled by default. The harness reads a root `AGENTS.md` when present and an optional `.zhivex/harness.json` manifest. Use `--context-config <workspace-relative-path>` to select another manifest or `--no-project-context` to disable project context discovery. Library callers use `contextConfigPath` and `projectContext: false` for the same controls.

Harness safety instructions always remain authoritative. Project context and rules can describe architecture, commands, conventions, and desired workflows; they cannot expand the workspace, expose secrets, enable tools, waive approvals, change budgets, enable network access, or weaken OCI policy.

The manifest uses schema version `1`:

```json
{
  "schemaVersion": 1,
  "contextFiles": ["docs/ARCHITECTURE.md"],
  "ruleFiles": [".zhivex/rules/typescript.md"],
  "skillDirectories": [".zhivex/skills"]
}
```

Paths are relative to the workspace. Version `1` does not accept globs, absolute paths, traversal, symbolic links, special files, sensitive filenames, or paths excluded by the workspace policy. File and aggregate byte limits apply before content is added to instructions.

## Progressive skills

Each immediate child of a configured skill directory may contain `SKILL.md`:

```markdown
---
name: repository-review
description: Review a repository change for correctness and security.
---

# Procedure

Inspect the diff, reproduce failures, and report evidence.
```

Initial instructions contain only the skill ID, description, scope, and digest. The read-only `load_skill` tool returns the bounded instructions only when the model selects that exact skill. Scripts and assets are not executed or loaded implicitly.

## Lifecycle hooks

The library can accept trusted, application-registered lifecycle handlers with stable IDs and versions. Their identities are bound into the harness fingerprint, and events contain safe lifecycle metadata rather than prompts, messages, tool arguments/results, or provider payloads.

```ts
const harness = await createHarness({
  lifecycleHooks: [{
    id: "local-audit",
    version: "1",
    events: ["approval-requested", "run-finished"],
    timeoutMs: 2_000,
    failureMode: "ignore",
    handle(event) {
      auditSink.record(event);
    }
  }],
  onLifecycleHookError(failure) {
    diagnostics.record(failure.hookId, failure.event);
  }
});

try {
  // runHarness(...)
} finally {
  await harness.close();
}
```

Hooks run sequentially, support selected events and bounded timeouts, and default to best-effort failure handling. Set `failureMode: "fail"` only when the registered application hook must stop the lifecycle operation.

Repository manifests cannot register executable code. Project-selected executable hooks, host shell hooks, and implicit `pre<script>`/`post<script>` package hooks remain unavailable. A future command-hook contract must execute within the acquired environment and preserve approval, journal, patch-review, and host-import boundaries.

## Durable compatibility

Context/rule/skill digests and trusted hook identities form part of the durable harness binding. Changing them intentionally prevents a paused run from resuming under different instructions. Complete or deny the old run with the artifact and context that created it, then start a new run.

Version `0.11.x` advances the resolved configuration schema from `4` to `5`. Existing SQLite state remains readable, but paused `0.10.x` approvals must be completed or denied with the matching artifact because project instructions and trusted hook identities are now part of the run fingerprint. Library cleanup should `await harness.close()` so the final lifecycle event and environment release complete.

## Bounded conversation evidence

File slices now return at most 16,000 content characters; a batched read shares
32,000 characters across its slices. The full-file digest is unchanged. `endLine`
identifies the last returned line so ordinary reads can continue from the next line.
`clippedLine: true` marks an overlong individual line whose text is incomplete; do
not treat that clipped text as the entire source line. Search an exact file to locate
relevant short excerpts instead of repeatedly reading a large file.

Conversation compaction uses `bounded-evidence-v6`. It retains a redacted excerpt of
the initial user objective, recent conversation excerpts, bounded local-tool path
and digest evidence, and a separate short history of check exit codes, timeouts,
and tool failures. These are recollections, not approvals or verification receipts.
The latest four check/error records are kept independently of ordinary file-read
noise. The latest three subsequent user excerpts are retained separately from
assistant chatter, redacted and bounded to 512 characters each. They share the
existing total summary budget and remain untrusted context. Interactive summaries
can carry this structure across subsequent compactions.

The latest successful `repair_plan` is retained separately from assistant chatter,
with bounded hypothesis, expected behavior, next check, and safe relative paths.
It remains model-authored recollection, never authorization or a verification receipt.
Older v1-v5 summaries remain readable. Original requests remain recoverable with
`read_task`; a summary is not a replacement for full acceptance criteria.

Context is useful working memory, not a proof system. Conceptual discussion,
decisions, hypotheses and unresolved questions remain available without a
`repair_plan` or verification receipt. Up to three redacted local diagnostic
excerpts (640 characters each) are retained as `unverified` observations, separate
from typed check records. These may include command stdout/stderr, SDK tool-error
messages and terminal-verifier diagnostics. They share the summary's total bound;
file bodies and external-tool payloads are not copied into these observations.
Repeated identical excerpts do not evict distinct decisions. A summary neither
authorizes an effect nor proves that a check passed.

Repeated hybrid compaction preserves the deterministic JSON and the model's
recollection separately. Recollection stays untrusted conversational material,
including when another model summarizes it. No additional provider or paid call
is selected automatically; `/compaction provider:model` selects that route.

Automatic compaction uses `adaptive-tokens-v1`. The configured recent-message count
is an upper target: the runtime selects a smaller complete tail when its estimated
size exceeds the token target. Calls/results and provider approval groups remain
correlated; pending approvals and durable compaction records remain SDK-owned.
The target is 65% of the trigger after allowing for system instructions, tools and
the summary. A protected newest group that cannot fit still fails closed.

Compaction and transport budgets share the same character-based estimator
(characters / 3 plus envelope allowance), not a provider tokenizer. Tool schemas
are measured separately from the configured message ceiling. Repair runs reduce
the trigger as remaining cumulative input allowance shrinks, aiming to leave room
for three requests; this does not increase budget ceilings. Unlimited-token mode
keeps the configured context thresholds. Explicit per-run compaction overrides
and `compaction: false` remain honored. No model context-window size is inferred.

For single-agent runs, the remaining balance updates after each provider response,
including within the same invocation. Before sending another request, the harness
checks estimated input against the remaining input and total budgets. Estimates
are heuristic; reported usage remains authoritative and can still exceed a limit.
Failed checkpoints include that reported usage even when the response's tools
were rejected.

In the `strict` profile, requests approaching the last 30% of the token budget
switch to a final answer with no new tools. The answer must distinguish collected
evidence from unfinished work. This is a best-effort closure reserve, not a
guarantee that every task completes within its budget. The `repair` profile keeps
its existing verification controller. Unlimited-token mode disables these token
stops and closure transitions.
Schema serialization is cached by schema identity; messages and tool descriptions
are measured anew. Transport accounting reuses its measurement for diagnostics.

Discovery tools now default to ten matches for `search_files` and path-only
`list_files` output. Request larger limits or `includeDigests: true` explicitly
when needed. The underlying Workspace API defaults are unchanged.

The summary additionally preserves up to eight deduplicated navigation references
from successful local searches and reads, including nested `search_many` and
`read_files` results: relative file path, observed digest, returned line range and
the clipped-line flag for reads. A newly observed digest replaces older references
for that file. The same 4,000-character total cap applies; references compete with
other recollections for space. Earlier v1/v2 summaries remain readable as untrusted
context, and every recalled reference is validated again.

These historical references help select the next focused read. They do not retain
source text, search queries, current-file guarantees or editing authority. The agent
must still read current source before constructing an exact replacement. No model
token reduction or SWE-bench improvement is established by retention tests alone.

Raw source, tool arguments, stdout/stderr, free-form errors and external MCP results
are not copied into evidence. Sensitive file paths are excluded. Summaries are
lossy: omitted material is flagged, and the runtime summary is capped at 4,000
characters and a source-relative budget. Exact failure diagnostics still require
reading the original durable run or rerunning the check. This does not infer a
semantic task plan or guarantee retention of every earlier user constraint.

The strategy identity participates in the durable harness fingerprint. Paused runs
created with the previous compactor must be completed or denied with their matching
artifact; they cannot silently resume under the changed context behavior.

Run `bun run evaluate:continuity` for deterministic retention, redaction, and agent
loop regressions. These checks do not measure model coding capability.

## Task continuity and repair policy (audit remediation)

The `bounded-evidence-v6` summary remains lossy and bounded. Original operator
requests are stored separately in run metadata (`zhivexTaskSources`), redacted,
deduplicated by digest and limited to 64 requests / 256000 UTF-8 bytes. Exceeding
that bound is an explicit error. `read_task` reads 4000 characters at an offset
and lists source IDs; summaries do not replace the original acceptance criteria.
Interactive sessions retain this metadata across turns and durable resumes.
Manual compaction keeps a bounded summary in the prompt and retains redacted
operator sources separately. The CLI persists them in session/run metadata.
Library callers using `compactHarnessMessages` should pass its returned array
directly into `runHarness`; if serializing it separately, also retain the original
`zhivexTaskSources` metadata. A summary alone cannot reconstruct full requests.
`repair_plan` records the hypothesis, expected behavior, up to eight known paths,
and the next check in the durable tool journal. Its optional `verifier` records
exact `command`, `args` and a bounded `purpose`. Neither tool creates approval
or proof that a task is solved.

The optional `repair` runtime profile is shared by CLI, library and external
benchmark. Before each actual provider request it predicts the full message and
tool-schema context, reserves 30% of input/output allowance for closure, and caps
requested output to the current phase allowance. The predictor uses serialized
characters, not the provider tokenizer: actual billing can exceed a prediction.
All reported usage remains counted; missing usage blocks further paid requests.
Qwen Responses cannot accept an output cap: the existing route is preserved and
`outputCapApplied` is false, so a response may consume more than the reserved
allowance. Explicit Qwen Chat and other supported transports receive the cap.
Thinking-enabled Qwen gets a restricted catalogue with automatic tool choice
instead of an unsupported named choice; the same verifier-request limit applies.

After an edit, the application inspects the candidate and creates a mandatory
verification obligation. If a verifier was registered, the controller schedules
`verify_and_apply_environment_patch` through the normal SDK approval flow without
another provider request. Otherwise it offers a minimal verifier-selection
catalogue for at most two requests. Failed checks allow bounded recovery; a plain
final response cannot mark a pending candidate completed. Successful checks bind
the argv digest and purpose to the candidate revision, but a zero exit code does
not independently establish that the chosen check covers the user's requirement.
Host-mode edits require an approved `run_check` before completion.

Applications that require an actual repair can set `requireVerifiedDelivery: true`
when creating a Harness with `agentProfile: "repair"`. This creates a durable
completion obligation before exploration starts; a final answer without a
verified delivery is failed in both the result and saved checkpoint. The option
is bound to the run fingerprint and cannot be removed by restoring the controller
with defaults. It does not itself open the closure reserve or grant permission
for tools. Inspection-only callers leave it false. The SWE-bench driver enables
it because its task explicitly requires a verified repair and import.

A concrete repair plan also prevents completion before a candidate exists. If
the provider returns a normal final answer with a pending obligation and known
usage, the controller may schedule one read-only `read_task` reminder through the
ordinary tool gates. Its durable counter survives resume; it cannot extend the
verifier-selection limit or repeat indefinitely. The next model request still
uses the original token, step and tool budgets. The original response's usage
is preserved. Unknown usage, errors, cancellation and output-limit finishes do
not trigger this reminder. A second premature final answer remains a failed
repair, not a delivered result.

An OCI edit attempted without a concrete verifier is rejected before execution
and records a durable planning obligation. The next provider requests expose
only `repair_plan` and `read_task`, for at most two planning attempts; supported
modes explicitly request `repair_plan`. Execution checks also block unrelated
tools until a valid verifier is recorded. These restricted planning turns can
use the existing closure reserve after ordinary work reaches its ceiling;
they cannot exceed the total input/output budget. Resuming does not reset this limit.
Recording the verifier restores the ordinary catalogue, but never supplies
approval for the edit or check and does not increase the token budget.

The working-state message sent with each model request includes the normalized
planned file paths and remaining closure read/command allowances. This view
comes directly from the enforcing progress controller, including after restore;
it does not depend on keeping an old `repair_plan` tool result in compacted
history. These counters describe the existing closure limits, not extra budget
or approval. Displaying them does not itself activate closure.

Work/closure usage, phase, candidate, receipts and bounded measurements persist in
the SDK's own checkpoint writes, without separate competing revision updates.
An abandoned `running` checkpoint is treated as uncertain accounting on resume:
a process could have died after billing and before saving the result. Approval
pauses with complete accounting can resume normally. `runs inspect <runId> --json`
exposes allowlisted `runtimeDiagnostics` and an `effectiveRuntime` manifest. Old
runs without those diagnostics yield null. Diagnostics never include raw argv,
source, command output or prompts; purpose text is redacted.

At 70% of either actual cumulative token allowance, broad discovery pauses;
four further read calls and three command calls remain. Every `read_files` path
is checked against the normalized plan scope. Approved verification remains
subject to the run deadline, lease and tool budgets.

A rejected plan leaves the previous accepted plan intact. An out-of-scope read
does not consume the closure read allowance, though it still consumes the ordinary
tool-error budget. Correcting or replacing a plan does not replenish allowances.
If an operation fails after changing a previously delivered candidate, the new
candidate remains pending verification across resume.

Primary and child definitions share the durable policy factory. Their manifests
identify the role, catalogue, budget and whether the primary closure controller
is installed. Read-only review groups and SDK-managed delegated runs do not gain
the primary transport scheduler; parent accounting still includes child usage
when `includeChildRuns` is enabled. This distinction remains explicit rather than
claiming identical repair execution across SDK entry points.

Read-only inspection does not reset duplicate tracking. Repeated identical
search evidence and fully overlapping read slices are suppressed on their third
observation; real reads still validate current bytes. Possible mutation/command
effects reset those hashes. Closure counters, known paths and bounded evidence
hashes survive SDK checkpoints in `zhivexRepairProgress`. Runtime read output is
limited to 32000 serialized characters per model step in this profile.

Changing the compaction strategy or runtime profile changes the harness binding.
Paused runs from an older binding must be completed/denied with their original
artifact; these changes deliberately do not reinterpret an old approval.

All harness profiles now return unknown tool selections as `TOOL_NOT_REGISTERED`
and invalid arguments as structured error feedback. This general-purpose recovery
is separate from the optional repair controller: the `strict` profile keeps
ordinary model-driven task completion without imposing a verifier plan. No
unregistered tool or invalid arguments are executed. Existing tool-error, step,
token and time limits bound recovery; callers can select `stopOnError: true`,
`validationErrorMode: "throw"` and `unknownToolMode: "throw"` explicitly. Delegated
runs use the same recovery defaults with sequential execution and their existing
child budgets. Subsequent mutations still require approval.

For required-delivery OCI runs, reaching the predicted work-budget boundary without a verifier transitions into the same durable two-attempt planning path before rejecting another exploration request. That request exposes only `repair_plan` and `read_task`. The estimate includes the working-state message and current tool catalogue; the budget gate recalculates after narrowing. This spends only the existing closure reserve, keeps total input/output ceilings, and neither executes nor approves a repair. Optional inspection runs do not gain access to the reserve.

Closure-reserve eligibility from this boundary is durable across checkpoints and remains active after recording the verifier, so planning can lead to an edit. A repair with an existing verifier can enter the same reserve. This does not replenish tokens, grant tool approval, or establish that a candidate satisfies the task.

### Qwen reasoning fragments

The harness losslessly joins adjacent plain Qwen `reasoning_content` fragments
before estimating saved histories and when collecting new model streams. This
removes repeated JSON envelopes without truncating reasoning text, tool calls,
or results. Signed or unknown provider data forms a boundary and is preserved
unchanged. Streaming aggregation flushes at 16 KiB of characters or the next
non-reasoning event. Oversized irreducible groups still fail closed; the CLI
identifies this as a context-compaction failure rather than an unknown cause.
## Hierarchical context and hybrid compaction

The pinned Zhivex SDK owns paid-compaction admission and durable attempt receipts. Harness supplies an explicit route fingerprint and reserves 32,000 input tokens plus 1,024 output tokens before the callback runs. The serialized utility input is capped below 31,000 UTF-8 bytes, leaving framing allowance; this conservative bound can reject a call when a tight budget cannot reserve it. Small sources use deterministic evidence and a zero-usage receipt. Confirmed usage survives summary rejection; interrupted or unknown attempts block paid retries. The separate Harness ledger remains responsible for per-route monetary limits and partial provider usage.

The SDK shared budget coordinator is available to library callers through an explicit run policy; it is not enabled automatically. Harness persistence supports its reserved namespace without widening tenant/user access. Portable backups include linked coordinator ledgers and reject unresolved reservations or unknown compaction attempts, so restoring a backup cannot silently reset the shared consumption. Backups created before these optional records remain readable.

Successful `read_file` and `read_files` calls discover ancestor `AGENTS.md` files
inside the workspace, excluding the already loaded root. Discovery is bounded,
rejects links/protected paths, and records both present and absent file identities
in SDK-owned checkpoints. Applicable guidance is supplied on subsequent requests,
with its scope and provenance; it cannot change permissions or verification.
The runtime refreshes these discovered scopes before model requests, including
normal edits, deletion and creation at a previously absent instruction path.
Updated guidance replaces the previous scoped context; it cannot authorize an
effect. Unsafe links, protected paths, invalid text and exceeded limits still
fail before that guidance reaches the model. The strict
`validateHarnessScopedContext` library function remains available for callers
that explicitly require fixed instruction identities. The root context bundle
and execution/approval fingerprints keep their existing binding rules.
Project context can still be disabled with `--no-project-context`.

Primary runs now monitor repeated tool-result cycles and long repeated text across
compaction and resume. Three unchanged cycles request a new hypothesis; five stop
before the next model call. Changed results break repetition. Bounded persisted
hashes contain no source text. Changing narration around identical tools does
not count as progress. Text-only repetition remains monitored independently of
tool turns. Reads are not replaced with cached evidence.
Trusted independent local reads use up to four SDK workers; writes, checks,
approvals, MCP and delegation remain barriers. This is not a latency benchmark.

Optional semantic compaction supplements deterministic evidence with an untrusted
recollection from an explicitly chosen model. Selection, credentials and usage are
separate from the primary model. It can summarize bounded, redacted local code
from read/search results as well as conversational decisions and diagnostics;
the model is no longer limited to typed operational evidence. These excerpts
share one input allowance and never include arbitrary external-tool/provider
payloads. See [CLI](CLI.md#configurable-model-assisted-compaction)
and [model catalog](MODEL_CATALOG.md). Tool metadata, approval state and verification
receipts remain outside the summarizer's authority. These runtime strategy changes
alter durable fingerprints: finish old paused runs with their original artifact.
Every runtime profile returns the matching persisted revision, including refreshed
context and accounting metadata, rather than an older in-memory SDK projection.
Named child agents keep their existing bounded runtime; these new primary-run
context/progress/compaction integrations do not claim a child-runtime migration.
