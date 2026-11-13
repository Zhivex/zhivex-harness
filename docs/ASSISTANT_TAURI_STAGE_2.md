# Assistant Tauri stage 2: project workspace and live activity

Implemented locally on 2026-11-13, following [the staged plan](ASSISTANT_TAURI_AGENT_PLAN.md).
Stage 1's shared Code composition remains the authoritative coding runtime. The general
Assistant view and service terminal remain available. No existing local changes were reset.

## Workspace journey

Configure a model in the native app, open **Proyectos**, and use **Abrir carpeta** to
choose a Git repository. The macOS native dialog hands its selection to the host over
its private parent pipe. The authenticated browser request contains no filesystem root.
The host canonicalizes and registers the selection using the stage-1 one-use token.
Other platforms expose already registered projects but do not offer a native chooser yet.

Select a project, open a file, attach its displayed lines, and submit a message. Project
conversations retain immutable runtime bindings. The resizable file panel uses Harness's
safe workspace reader (100 files per page, up to 1,000 displayed; 120 lines per read).
Attachments carry path, digest and line range; the host rereads them and rejects changed
bytes before starting a run. At most four attachments and 60,000 assembled prompt
characters are accepted. File/line links open the same scoped reader. Attached content
is shown as file references in chat rather than exposing the internal prompt envelope.

The central conversation displays incremental text and tool states. The lower resizable
panel shows tool activity and bounded output from `run_check` and
`run_environment_command`, including exit codes. Outputs are limited to the most recent
run's eight command receipts, with 4,000 characters per output stream. It is not a PTY.
Known provider credentials and the core redaction policy apply before output truncation.
The header shows the configured model and explicit local/OCI execution mode.

Navigation remains available while a run is active. **Detener** routes cancellation to
the owning run with its current revision. Browser reload restores the selected binding;
activity replay deduplicates by cursor and event identity. Expired cursors rebuild from
an engine snapshot. Pending drafts stay scoped to their conversation while this view is
mounted; drafts are not persisted across reloads. Use **Actualizar proyectos** to discover
conversations created from the connected terminal.

## Transport and authority

- Workspace HTTP routes retain bearer authentication, Origin validation and admission
  limits. The webview receives no native shell capability or generic protocol dispatcher.
- Activity uses bounded five-second long polling, released on shutdown and aborted on
  navigation. It adapts Desktop's activity reducer without importing Desktop internals.
- Snapshot responses omit approval authority and rich raw run payloads. Command output
  access verifies conversation/run membership. File traversal, state files and symlinks
  outside the project are rejected by the existing Workspace implementation.
- Managed native startup opts into the shared coding composition and includes provider
  identity in the runtime configuration fingerprint. Profile changes are blocked while
  known project runs are pending, including approval waits.
- General web-only startup remains opt-in for coding. The browser cannot invent or
  authorize a project root; it may request the native dialog only when supplied by its host.

## Validation

- `bun run check:assistant`: 141 source tests passed; offline smoke and installed-candidate
  validation passed (140 tests, one expected skip for the separate Code checkout).
- Additional Code integration assertions verify a real approved package check's command
  and exit code reach the workspace output projection. Seven application tests passed.
- Workspace HTTP tests cover unauthorized/foreign-Origin requests, rejected raw root
  input, native request correlation/cancellation, traversal/symlink/state exclusion,
  changed attachment digests, secret redaction, cross-conversation rejection and shutdown.
- Activity tests cover duplicate/out-of-order events, failed tools and expired cursors.
- `bun run packages/assistant/scripts/smoke-workspace.ts`: real host, temporary Git repo,
  simulated streaming provider, file attachment, tool result, navigation during execution,
  relative file links, reload without duplicates, cancellation and mobile layout.
- Actual release Tauri webview: native NSOpenPanel selection, file inspection/attachment,
  streaming `read_file` and response, session navigation, follow-up cancellation observed
  as **Detenida**. This used an isolated copy of the app with the same Rust shell, host,
  workspace routes and built UI; its child entrypoint supplied an offline model and
  temporary state. Managed onboarding and real provider calls were not part of this test.
  Reload/replay was verified in Chromium; a native reload shortcut is not provided.
- Architecture boundaries, root typecheck and 19 architecture/composition tests passed.
  Rust: two tests passed. The production Tauri bundle and its lifecycle smoke passed.

See [the evidence report](reports/TAURI_STAGE_2_2026-11-13.json). Reproduce the browser
smoke after `bun run --cwd packages/assistant build`. For native fixture validation, bundle
`scripts/workspace-fixture.ts` as the temporary copy's child entrypoint and pass `--native`;
never replace the production host or use real profile state for that fixture.

## Remaining stages and distribution

Stage 3 adds native approval/diff/checkpoint review. Until then, pending coding approvals
must be handled through Code's attached service terminal; the workspace does not approve
them. Stage 4 adds an interactive terminal. No signed/notarized release, provider-backed
coding evaluation, Windows/Linux native chooser or OCI execution certification is claimed.
The built app retains the stage-1 local Harness candidate requirement: publish compatible
engine exports and update consumer pins before distributing against registry dependencies.
No commits, pushes, publication or changes to the user's profile were performed.
