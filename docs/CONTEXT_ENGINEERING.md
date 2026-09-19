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

Conversation compaction uses `bounded-evidence-v3`. It retains a redacted excerpt of
the initial user objective, recent conversation excerpts, bounded local-tool path
and digest evidence, and a separate short history of check exit codes, timeouts,
and tool failures. These are recollections, not approvals or verification receipts.
The latest four check/error records are kept independently of ordinary file-read
noise. The latest three subsequent user excerpts are retained separately from
assistant chatter, redacted and bounded to 512 characters each. They share the
existing total summary budget and remain untrusted context. Interactive summaries
can carry this structure across subsequent compactions.

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

The `bounded-evidence-v4` summary remains lossy and bounded. Original operator
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
tools until a valid verifier is recorded. Resuming does not reset this limit.
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
