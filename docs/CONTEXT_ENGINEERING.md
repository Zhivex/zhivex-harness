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
