# Tauri stage 6: previews, browser verification and artifacts

Stage 6 adds an explicitly reviewed static preview pipeline to the existing Assistant
workspace. Code still builds the application through its reviewed checks, or the human
uses the stage-4 terminal. The preview adapter never introduces another shell executor.

## User journey

1. Build a static web output in a project or isolated task, for example `dist`.
2. Open **Previews y evidencia**, select that relative directory, and review its complete
   file list, byte count and content digest. Confirm publication explicitly.
3. Assistant captures those files and starts its own static server process on a new
   OS-assigned loopback port. The server serves only that immutable capture.
4. Review and authorize a separate browser plan. The UI supports a relative path and
   visible-text assertion; the agent tool additionally supports bounded clicks.
5. Inspect the screenshot, exact plan, outcome, timestamp, output digest and observed Git
   revision. Comments create separate immutable records anchored to the evidence ID.
6. Stop the previews explicitly, close the task environment, or quit Assistant. Servers
   expire after 30 minutes. They do not resume automatically after a restart.

This supports static HTML and compiled static exports. It does **not** attach to existing
ports, run arbitrary framework dev-server commands, proxy remote applications, provide
HMR, or verify applications requiring a backend. Use Code/terminal for builds. Source
provenance records the project observed at publication; it is not proof that a build
actually incorporated that source. The screenshot proves only the displayed plan against
those captured output bytes, not comprehensive visual correctness.

## Composition and compatibility

- `src/preview/controller.ts` owns publication reviews, process and browser lifetimes,
  bounded artifacts and a fixed in-process MCP client.
- `src/preview/preview-server.ts` is a separately bundled worker. It receives captured
  files over private IPC and never reads the repository or imports the privileged host.
- `src/preview/revision.ts` fingerprints HEAD and bounded nonignored working files,
  including dirty and newly created files. State under `.zhivex-harness` is excluded.
- New local Code runtimes expose `preview_verify` through the public Harness MCP API.
  Network permission keeps every invocation approval-gated. The existing stage-3 review
  receipt binds the exact origin, preview ID, content digest and plan.
- Previously initialized runtimes retain their prior tool composition and fingerprints.
  `preview-tools.binding` enables the capability only in newly initialized local runtimes.
  Existing pending approvals remain resumable. Create a new isolated local task to use the
  browser tool with the agent; manual verification is available in existing environments.
- OCI runtimes do not receive this host-side tool: their existing no-network boundary is
  retained. Manual verification is a separately authorized host operation.
- Authenticated workspace routes and the native desktop lifecycle are reused. The browser
  is separate from the Tauri webview and receives no Assistant bearer or provider secrets.

## Boundaries and limits

Publication tickets are single-use, expire after five minutes, and recheck captured output
before starting. At most two preview processes run concurrently. The worker owns its
listening socket; no available-port probe or foreign process is accepted as ownership.
It checks the exact Host header, serves only GET/HEAD, sends no CORS grants and denies
frames, forms, objects and external subresources with CSP. Hidden files, `node_modules`,
symlinks, unsupported extensions and paths outside the selected directory are excluded
or rejected. Reads reuse the desktop-derived no-follow reader. Limits are 512 served files,
2 MiB per file, 16 MiB total, 2,048 directory entries and depth 12.

Chromium uses a fresh context, blocked service workers, disabled download acceptance,
closed popup pages and blocked WebSockets. HTTP requests must stay at the exact owned
origin. Plans allow at most ten clicks/text assertions, no arbitrary evaluation, and a
30-second deadline. Screenshots are fixed at 1280 × 800 and bounded to 2 MiB. This is an
application/network boundary, not an OS sandbox for Chromium vulnerabilities. The separate
preview origin has no credentials capable of calling privileged host operations.

Evidence lives in the private host state directory `preview-artifacts`, outside worktrees.
A durable running record precedes browser launch; an atomic final record stores success
or failure and the PNG digest. Interrupted records become failed evidence after restart;
checks are never replayed. Evidence is limited to 500 records/64 MiB. Full storage refuses
new evidence instead of silently deleting it. Existing images are integrity-checked on load.
Output and source revisions are recomputed when listing artifacts. Unknown source state
is never shown as fresh. Source hashing is bounded to 4,096 Git-listed files, 2 MiB per file
and 32 MiB total; unsupported files or limits produce unknown provenance.

Playwright is a production dependency. Chromium must be installed for that runtime version
in the user's normal Playwright cache (`playwright install chromium`); the app does not
silently download a browser. A missing browser yields visible failed evidence. Browser
binary provisioning and signed distribution belong to the stage-7 packaged pilot.

## Validation

The stage-6 tests exercise immutable publication, one-use/stale review tickets, rejected
symlinks/hidden-file access, Host/method checks, cross-project denial, real Chromium clicks
and text assertions, blocked requests to another local server, persisted screenshots,
failed checks, feedback, stale evidence, restart and cleanup. An offline model uses the
actual Code composition and cannot create browser evidence before the stage-3 approval.

`bun run packages/assistant/scripts/smoke-preview.ts` exercises the rendered UI, separate
publication/browser confirmations, screenshot display, feedback, stale labels and a
390-pixel viewport. The full `check:assistant` suite also tests a separately installed
consumer. See the [stage-6 validation report](reports/TAURI_STAGE_6_2026-11-13.json) for the
observed results and limitations.
