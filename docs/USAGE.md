# Usage reference

Start with [First use](FIRST_USE.md). This reference covers scripting, providers,
execution and security boundaries.


Start the durable console with the ergonomic command, or use the long alias in existing scripts:

```bash
zhx
zhx chat --continue
zhivex-harness --version
```

Inside the console, `/help all` lists `/provider`, `/model`, `/route`, `/status`, `/diff`, `/review`, `/resume`, `/pending`, `/approve`, `/deny`, `/compact`, `/new`, `/rename`, and `/exit`. Tool and step activity is rendered without tool payloads; approval cards sanitize terminal controls and keep governed edit/command payloads fully reviewable.

The 1.0 console includes Tab command completion, `/paste` for previewed
multiline tasks, `/context` for active project rules/skills, and `/attach <path>` for
bounded file excerpts. Ctrl+C interrupts active work while retaining the session;
errors return to the prompt. See the [interactive workflow](./CLI.md#interactive-daily-workflow)
for attachment limits, approval behavior, and recovery.

Project context engineering is enabled by default. A root `AGENTS.md` plus an optional `.zhivex/harness.json` can declare bounded context files, rule files, and progressively loaded `SKILL.md` directories. Disable discovery with `--no-project-context` or select another manifest with `--context-config`.

Show providers and detected configuration without printing secrets:

```bash
zhx providers
zhx providers --json
```

Run a task against the current directory:

```bash
zhivex-harness run --provider openai "review the repository and fix the tests"
zhivex-harness run --provider meta "document the current architecture"
zhivex-harness run --provider qwen "implement the pending endpoint"
zhx run --provider gemini "review the proposed implementation"
```

Operate on another workspace:

```bash
zhivex-harness run --provider qwen --workspace ../my-app "fix the typecheck errors"
```

Interactive mode:

```bash
zhx chat --provider meta
zhx chat --continue
zhx sessions list
```

Route only selected subagent roles; credentials are required only for providers actually instantiated:

```bash
zhx run --provider openai --route explorer=qwen --route reviewer=gemini \
  "implement the change, then review it independently"
```

Routing with `--max-cost-usd` remains rejected in `1.0`: aggregate usage cannot yet be priced correctly when roles use different models.

Writes and checks pause for approval. In a non-interactive execution, state is saved in `.zhivex-harness/runs/operations.sqlite`:

```bash
zhivex-harness resume <runId> --approve
zhivex-harness resume <runId> --deny
```

Duplicate external requests can share a durable run identity:

```bash
zhivex-harness run --idempotency-key issue-482 "fix the reported regression"
```

Operate on runs without loading a provider or requiring its credential:

```bash
zhivex-harness runs list --status waiting_approval
zhivex-harness runs inspect <runId> --json
zhivex-harness runs export <runId> --json
zhivex-harness runs cancel <runId> --reason "superseded"
zhivex-harness runs cleanup --before 2026-08-01T00:00:00Z
```

Operations are scope-bound. The defaults are tenant `local` and a namespace derived from the canonical workspace. Supply the same `--tenant`, `--user`, and `--namespace` values across run and operator commands. Migration, budgets, redaction, retention, and compatibility limits are documented in [docs/DURABLE_OPERATIONS.md](./DURABLE_OPERATIONS.md).

Use governed MCP and bounded subagents explicitly:

```bash
zhivex-harness run --mcp-config examples/mcp-config.json "consult the allowed documentation tools"
zhivex-harness run --subagent explorer --subagent reviewer "analyze the boundary"
zhivex-harness review --reviewer explorer --reviewer reviewer --json "review the durable runtime"
```

MCP configuration, capability gates, child budgets, promoted approvals, review groups, migration, and known limits are documented in [docs/EXTENSIBILITY.md](./EXTENSIBILITY.md).

`--yes` automatically approves tools with side effects. Use it only inside a disposable or isolated workspace:

```bash
zhivex-harness run --provider openai --yes "apply the change and validate it"
```

Structured automation output uses schema version `1`:

```bash
zhivex-harness run --provider qwen --json "analyze the issue without modifying files"
zhx run --provider gemini --jsonl "analyze the issue without modifying files"
```

The JSON shapes and exit codes are documented in [docs/CLI.md](./CLI.md).

Create a portable change-admission envelope from structured, redacted evidence and the exact patch bytes, then verify it without provider credentials or network access:

```bash
zhx changes create examples/change-envelope-input.json --patch examples/change.patch > change-envelope.json
zhx changes verify change-envelope.json --patch examples/change.patch
```

The verifier proves integrity, expiry, and explicit preconditions; it deliberately reports approval and external-attestation authenticity as `not-verified`. See [docs/CHANGE_ENVELOPES.md](./CHANGE_ENVELOPES.md).

Repository edits use digest-bound proposals. Discovery returns `nextCursor` when another deterministic page is available; mutating tools reject stale content instead of merging or overwriting it. Deletions move files into harness-owned quarantine and return a recovery identifier. The complete contract and migration from `0.2.x` are documented in [docs/REPOSITORY_EDITING.md](./REPOSITORY_EDITING.md).

The default check allowlist is `test`, `typecheck`, `lint`, and `build`. Replace it with repeatable CLI flags when a repository uses different declared scripts:

```bash
zhivex-harness run --allow-check test:unit --allow-check format "apply the fix and validate it"
```

The harness uses a pinned `packageManager` field when present; otherwise it accepts one unambiguous npm, pnpm, Yarn, or Bun lockfile and defaults to npm when neither signal exists. It executes only the selected script and rejects symbolic-link or ambiguous lockfiles plus implicit `pre<script>`/`post<script>` lifecycle hooks.

Enable enforced local execution explicitly. The image must already exist locally; the harness never pulls it implicitly:

```bash
docker pull node:24-bookworm-slim
zhivex-harness doctor --execution oci
zhivex-harness run --execution oci --yes "inspect, implement, test, review the environment patch, and import it"
zhivex-harness run --execution oci --oci-shell ask "use a reviewed shell pipeline inside the isolated snapshot"
```

`--yes` approves eligible command execution and the distinct host patch import; it cannot enable a shell whose policy is `deny`. Omit it when a human should review each durable approval. Configuration, threat boundary, cleanup, and certification details are in [docs/EXECUTION_ENVIRONMENTS.md](./EXECUTION_ENVIRONMENTS.md).

## Providers and defaults

| Provider | Default model | Support in `1.0.0` |
| --- | --- | --- |
| Meta | `muse-spark-1.2` | `MODEL_API_KEY` · 1.0.0 release-bound base, delegation, and OCI execution certified |
| Qwen | `qwen3.8-max` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` · 1.0.0 release-bound base, delegation, routing, and OCI execution certified |
| OpenAI | `gpt-5.6-luna` | `OPENAI_API_KEY` · 1.0.0 release-bound base, delegation, routing, and OCI execution certified |
| Gemini | `gemini-3.6-flash` | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` · provisional until the harness live matrix passes |

Override any model with `--model`. Optional provider overrides are `META_BASE_URL`, `QWEN_BASE_URL`, `QWEN_WORKSPACE_ID`, `QWEN_REGION`, `OPENAI_BASE_URL`, and `GEMINI_BASE_URL`. Non-credential transport settings are hash-bound to durable resumes without persisting their values.

The exact `v1.0.0` release passed protected base, delegation, routing and model-directed OCI gates for Meta, Qwen and OpenAI on 2026-09-20. The representative matrix passed 14/14 cases per provider on its authorized second attempt. Gemini remains provisional. See the [release evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/LIVE_CERTIFICATION.md#current-public-status) for artifact identity and the preserved first-attempt failure. Controlled and official-SDK MCP interoperability are separate transport evidence. Credential detection and deterministic tests do not replace real provider certification.

Older release certifications remain in the [historical evidence](https://github.com/Zhivex/zhivex-harness/blob/main/docs/LIVE_CERTIFICATION.md#historical-release-bound-evidence); they are not the current installation baseline.

## Security boundaries

- Every workspace path is resolved against a canonical root.
- Reads and writes that cross an external symlink are rejected.
- Dependencies, build output, Git internals, harness state, `.env`, `.npmrc`, and private keys are excluded from model exploration.
- The model has no generic shell.
- Only explicitly allowed, declared package scripts can run; the model must provide the exact script text for approval binding.
- Checks run without automatic `.env` loading and with a reduced environment.
- Patch application, moves, quarantine, restore, and command execution require interruptible approval.
- Every edit carries the digest observed during inspection; stale creates and updates fail closed.
- Existing file modes are preserved and successful replacements are published atomically.
- Unsafe state roots, protected workspace paths, files, and symlink targets are rejected before a run store is created.
- Environment values are not injected into prompts, diagnostics, or tool responses.
- Remote MCP output is bounded, schema-checked, treated as untrusted, and rejected on common prompt-injection directives.
- Network MCP always pauses for approval; custom read-only annotation trust must be explicit and injected by the host application.
- Subagent children inherit scope, workspace, cancellation, approval, and store policy while retaining independent budgets and fingerprints.
- OCI execution binds the durable run to the resolved image identity and enforced policy; resume fails if either changes.
- Snapshot discovery excludes secrets, Git internals, harness state, dependency trees, and build output. Dependencies may be mounted separately read-only.
- Untrusted commands receive a quota-backed tmpfs workspace, never a writable host bind; only successful, frozen, validated snapshots replace durable environment state.
- Container processes receive no provider credentials or arbitrary host environment values, and host changes require a separately approved digest-bound patch import.

The default `none` backend provides governance but no OS isolation and therefore exposes no shell-class tool. The local OCI backend enforces the documented container boundary, but it is not a VM or a managed hostile-code sandbox; use a dedicated host or microVM when the container runtime itself is outside the threat model.

