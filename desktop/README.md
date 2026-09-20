# Zhivex Harness desktop alpha — in progress

HAR-HU-26 architecture validation and HU27 project/conversation navigation and HU28 chat are
implemented. HU29–35 retain separate acceptance criteria. Uses an isolated React renderer, validated preload bridge and separate
runtime utility process sharing the existing Harness client/service contract.

```sh
bun install --cwd desktop --frozen-lockfile
bun run --cwd desktop build
bun run --cwd desktop typecheck
bun run --cwd desktop start
# Optional initial repository:
bun run --cwd desktop start --workspace /absolute/repository
bun run --cwd desktop smoke
bun run --cwd desktop package
bun run --cwd desktop smoke:packaged --empty-start
```

The launcher opens without a project; use “Abrir repositorio” to choose a Git
repository. Native folder selection is canonicalized to the Git root. Recent
projects persist in a private bounded index under the app user-data directory.
Selecting a project or conversation only reads state; creating a conversation and
sending a task require their own controls. Tab/Enter/Space work on native buttons;
Up/Down/Home/End move focus within the navigation lists. Provider keys, if used,
come from the host environment; do not pass them on the command line. The smoke
creates a temporary repository, uses an offline model and writes a screenshot plus
JSON report under the reported temporary directory. `--smoke-test` is an explicit
host-launch fixture mode, never a renderer request or implicit fallback.

The macOS arm64 .app is in `desktop/out/Zhivex Harness-darwin-arm64/`. It is unsigned
and unnotarized. Do not present it as a production installer. Packaging copies only
bundled application files and minimal metadata into the app; dependency caches,
source files and credentials are not copied. A separate Node installation is not
required. Docker/OCI remains optional and external; verify it using
`bun --no-env-file run scripts/oci-execution-smoke.ts` from the repository root.

When opening/reopening a project, recovery confirms the prior PID is dead before
removing stale transport. It preserves databases and refuses a live owner. The default
service directory is `/tmp/zhx-desktop-<uid>` and must be canonical for this desktop
launcher. Normal quit drains accepted work; forced process termination can interrupt
an invocation. Pending approvals remain durable.
Do not forcibly remove ownership files to bypass a live service.

Architecture, threats and acceptance limits: [DESKTOP_ARCHITECTURE.md](../docs/DESKTOP_ARCHITECTURE.md).


Each opened project has its own runtime and service project binding. Navigation
never redirects in-flight commands; responses from a previous view cannot replace
the selected project's state. Closing the application coordinates all opened runtimes
and keeps the window visible until accepted work has stopped.
A second application instance focuses the existing window instead of opening a
second catalog/runtime owner. Missing repositories and disconnected sessions show
recovery actions. No repository branch or working-tree contents change on selection.

The packaged smoke covers two Git repositories, separate conversation lists,
cross-project session rejection, no new runs on navigation, keyboard activation,
renderer reload, empty launch, invalid-folder recovery and duplicate launch.
For deterministic automation only, host `--fixture-project` arguments supply the
native picker's results; the renderer never supplies a path. Registry tests also
verify canonical aliases, concurrent persistence and unchanged uncommitted files.

## Chat and recovery (HU28)

The timeline groups the user's message, streamed response, tools and check receipts
by run. Failed checks show their actual exit code; missing receipts are explicitly
unverified. Repository content is literal text, with no HTML/Markdown execution.
The renderer receives redacted activity and safe run metadata, not raw engine output,
CLI result objects or approval arguments. Diff/approval review remains HU29.

Double submit is blocked synchronously. If a command response is lost after admission,
the UI requires “Actualizar estado” before sending again, and reconciles the stored
run instead of automatically resubmitting it. A failed activity poll preserves the
cursor and retries reads; reopening uses replay or an explicit expired-cursor snapshot.
Session queries work during streaming, so renderer reload does not require cancelling
the engine. After a service crash, “Reabrir proyecto” launches a replacement only
after proving that the prior transport owner is dead. It recovers stored runs and
pending approvals without resubmitting work. An interrupted active run can be
explicitly cancelled once its execution lease expires (normally up to 30 seconds).
A live lease rejects that cancellation with a retry instruction. Cancellation
preserves prior messages, tool receipts and file effects; it does not roll back
changes or certify an interrupted tool's outcome. Descendants receive cancellation
requests while retaining their own leases; completed descendants remain completed.

If the renderer process dies, a native dialog offers “Recargar conversación” or
“Cerrar aplicación”. Reload only reconnects and reads existing state. Closing a
window with an approval pending exits the application and worker; recent projects,
sessions and approval identities persist. Main-process review receipts do not
survive application restart, so the user must review again before approving.
Closing during active work offers “Volver a la app” or “Cancelar trabajos y salir”.
The host pauses new mutations across opened services while deciding; reads and
explicit cancellation remain available. Returning resumes admission without
cancelling. Choosing cancellation requests it once per host and waits for completion.
Unconfirmed cancellation or an unavailable host keeps the window open and restores
admission where possible. No process is forcibly terminated and cancellation does
not roll back effects. Both window-close and application-quit use this path.

Run `bun run build` from the repository root, then `bun run --cwd desktop build`
and `bun run --cwd desktop smoke:restart` to exercise three complete app launches,
renderer termination, window closure and CLI/desktop session coherence. For the
unsigned package, use `bun run --cwd desktop package` followed by
`bun run --cwd desktop smoke:restart:packaged`. The native reload choice is selected
by a host-only fixture; no renderer IPC is added and no provider API is contacted.
Append `--active-close` to either restart smoke to verify staying with an active run,
explicit cancellation on quit, worker exit and recovery of that same cancelled run.
Append `--effect-crash` instead to kill the offline worker after a real fixture-file
write but before journal completion. Recovery preserves the file, shows “Resultado
sin confirmar”, rejects the old approval, waits for lease expiry before explicit
cancellation, and allows a new run without replaying the tool. This does not infer
success from matching file bytes or expose an applied diff without its receipt.
The fault hook requires host-launch fixture flags and is absent from renderer IPC.
“Cancelar” is also available when a run is waiting for approval.

Applied decisions now offer “Ver cambio aplicado” in their history. Complete
before/after previews are stored with decision admission before execution, bounded
to 2 MiB across a run (individual review projections retain the 256 KiB limit).
The service returns them only on `run.get` with `includeDiff: true`, after matching
the decision, proposal, exact paths and content digests to completed journal effects.
This historical view remains unchanged by later repository edits. Older decisions,
incomplete previews or exhausted archive capacity show “Diff final no disponible”.
The renderer displays literal text and identifies content altered by redaction.

## Managed task worktrees (HU31)

The host-side manager in `src/task-worktrees.ts` creates a new `feat/` branch and
worktree from the selected repository's committed HEAD. It stores task identity,
source project, initial commit/ref, branch, checkout and separate state-directory
paths in a private atomic index. It does not copy staged, unstaged or untracked
source changes. Creation checkpoints survive restart; interrupted creation becomes
`needs-attention` without rerunning Git or deleting files.

Removal requires a fresh one-use review. Dirty and ignored files, unintegrated
commits and Git worktree locks block removal. The host rechecks the review and uses
Git's normal removal checks without `--force`; it never deletes the branch or task
state directory. Hooks, fsmonitor and configured clean/smudge/process filters are
disabled for manager operations, including status and removal. These worktrees use
committed file content; dependency installation and LFS/filter execution are not
implicit creation steps.

Open “Tareas aisladas” to create a task. Choose its title and optional new `feat/`
branch, then explicitly accept starting from the source repository's committed HEAD.
Each task opens its own worker and conversation database outside the checkout.
The panel shows its branch, base commit and status, and lists sibling tasks while
one is selected. Switching tasks preserves work running in the other workers.

“Revisar limpieza” displays pending paths, unintegrated commits and Git locks.
Only a clean, integrated, unlocked checkout can enable “Retirar worktree revisado”.
Active runtime work blocks removal; the host pauses admission before closing an idle
worker and rechecking the Git review. The task record, branch and conversation
state remain on disk. Removed tasks cannot be reopened through this panel; it does
not yet expose archived conversation browsing or automatic repair of interrupted
creation. Such records remain visible for manual inspection.

Use `bun run --cwd desktop smoke:worktrees` after building, or
`bun run --cwd desktop smoke:worktrees:packaged` after packaging. The offline fixture
creates two tasks through the UI, verifies simultaneous runs and cross-task session
rejection, cancels both, restarts the whole application, verifies the same sessions
and separate files, refuses dirty cleanup and removes only the reviewed clean task.
It also checks the original staged/unstaged/untracked files and index remain intact.

Packaged smoke executes a real read_file and an explicitly fixture-approved run_check
that exits 7. It verifies failed-check display, duplicate-submit protection, a lost
response after accepted work, temporary transport unavailability, renderer reload
during streaming, expired snapshots, literal hostile markup and a secret split across
chunks. Fault switches exist only on the trusted host's fixture runtime object; they
are not part of the preload bridge. No model API is contacted.

## Approval review work in progress (HU29)

A pending run offers “Revisar solicitud”. The host retrieves the exact scoped run
and exposes a bounded review projection with run revision, approval digest, payload
digest, expiry, files, commands and consequences. Literal replacements are explicitly
labeled as fragments; full-content edits do not invent an unseen preimage. Redacted,
invalid or oversized payloads are marked incomplete. The raw approval wrapper and
host signatures remain private.

The main process now issues bounded, single-use review receipts. Decisions carry
only the opaque receipt and an explicit boolean; the host supplies the captured run
revision and approval digests. Direct approval.resolve from the renderer is rejected.
Expired receipts fail locally and competing clients remain subject to engine revision
checks. Lost responses require reconciliation and a new review, never blind replay.
Approval is enabled for complete run_check and protected file-edit previews
(apply_patch, apply_reviewed_edits, apply_reviewed_replacement). Exact UTF-8 base
bytes, including BOM/CRLF, are bound to the expected digest and displayed beside
the destination. Missing/create-only, stale, protected, invalid UTF-8, oversized or
redacted bases cannot enable approval. Rejection can cover incomplete proposals.
When the host is configured for OCI, apply_environment_patch and
verify_and_apply_environment_patch use read-only artifact previews including
create/update/delete operations and before/after modes. Verified reviewed edits
show complete host-bound contents and exact verifier argv; the execution transaction
still requires a clean snapshot and unchanged post-verification patch. Packaged
macOS arm64 smoke verifies file rejection, subsequent approval and exact bytes.
OCI behavior has integration evidence with a fixture runtime; packaged OCI and
real-runtime validation remain separate.

The per-run “Historial de decisiones” reads durable service decisions and journal
receipts on demand, including older runs after renderer reload. It distinguishes
rejected, applied, failed, succeeded and unconfirmed outcomes, with file effect
digests and check exit codes. Pages load explicitly. This does not yet bind a plain
run_check receipt to the exact bytes of a preceding patch. Verified OCI import
receipts instead expose the exact patchId, verifier argv and successful exit code.
The history rejects mismatched run/patch/argv receipts instead of showing verified.


HU29 closure demonstrations:

- `bun run --cwd desktop smoke:packaged --empty-start` verifies file review,
  rejection/application, history after reload, service-side expiry and stale
  decisions after another client resolves the request.
- `bun run --cwd desktop smoke:packaged --oci-review` verifies complete OCI
  reviewed-edit contents, explicit approval, exact host bytes and patch-bound
  verifier evidence in the UI. The runtime boundary is a fixture, not Docker.

Test clock control is confined to the main/utility process fixture path; the
renderer bridge cannot change time, environment configuration or runtime adapters.
The service constructor accepts a trusted approval clock for deterministic tests.
Normal launches use the system clock. Fixture flags require explicit process args.

## Recovery work in progress (HU30)

“Reabrir proyecto” reconnects the selected project. When the old auxiliary process
is gone, the new runtime automatically invokes dead-owner transport recovery;
missing transport is normal for a first launch. Live owners and unsafe transport
files are rejected. Recovery holds the workspace SQLite write lock while proving
ownership and deleting stale transport, preventing concurrent recoverers from
removing a newly started service's files. No separate stale marker survives a crash.

The pending-approval recovery smoke kills the auxiliary process, reopens through
the UI, verifies a new PID and the same undecided run, then rejects/applies through
the normal flow. This does not yet prove recovery during an active tool effect or
closing/reopening the entire app with a pending approval. HU30 remains in progress.
