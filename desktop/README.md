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

For a dead prior owner, explicit `--recover` confirms its PID is dead before removing
transport files. It preserves databases and refuses a live owner. The default
service directory is `/tmp/zhx-desktop-<uid>` and must be canonical for this desktop
launcher. SIGTERM/normal quit drains accepted work; pending approvals are durable.
Do not forcibly remove ownership files to bypass a live service.

Architecture, threats and acceptance limits: [DESKTOP_ARCHITECTURE.md](../docs/DESKTOP_ARCHITECTURE.md).


Each opened project has its own runtime and service project binding. Navigation
never redirects in-flight commands; responses from a previous view cannot replace
the selected project's state. Closing the application drains all opened runtimes.
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
the engine. A service process crash and restart remains the fuller HU30 recovery flow.

Packaged smoke executes a real read_file and an explicitly fixture-approved run_check
that exits 7. It verifies failed-check display, duplicate-submit protection, a lost
response after accepted work, temporary transport unavailability, renderer reload
during streaming, expired snapshots, literal hostile markup and a secret split across
chunks. Fault switches exist only on the trusted host's fixture runtime object; they
are not part of the preload bridge. No model API is contacted.
