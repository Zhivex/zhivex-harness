# Web workspace flow

The private Zhivex chat repository was not readable from this environment. The flow below follows the Harness brand tokens and `@zhivex-ai/react` 0.9.0. Approvals, file-view gates, and per-operation limits are unchanged.

## First load

The empty workspace showed a disabled composer, a separate “Create a session” step, and solid grey suggestion cards. Zhivex chat opens on a composer and sends a starter prompt immediately. The composer is ready on load. The first send creates the session and starts the task. Suggestion cards send.

## Choosing a model

Rows wrapped, concatenated metadata, and repeated “No credentials”. The picker now uses one line per model: name, capability chips, context and price, and a star. Configured providers come first. “Configured only” starts on. Unconfigured providers share one note that points at the CLI. Search matches model or provider names. The last-used model is remembered per workspace.

## First message

Enter sends. Shift+Enter inserts a newline. Cmd/Ctrl+Enter still sends. “New session” stays available. If no provider has credentials, the composer explains that and does not start a run.

## Streaming

Consecutive read-only calls render as one collapsible “Explored N files” item. Other calls stay on their own rows. The change-review panel says when a run is only reading files, so nothing is waiting for approval.

## Approvals

Approve and reject stay in the change-review panel. Every file must be viewed before approve. Enter does not decide. The stream shows a review card with no decision buttons.

The header shows Manual, Auto-edits, or Auto with limits. Manual is the default. Auto-edits applies file edits inside the project. Auto with limits also runs commands named in the workspace allowlist. Network, secrets, git push, package publish, writes outside the project, deletes outside the project, and anything over a spend or token limit still wait for a person. Press m to return to Manual for this session. Each auto-approved edit is written to the audit log and can be undone while the file still matches the approved text.

## Terminal review

The terminal review names what the change does, lists each file with +/- counts, and shows line numbers with word-level markers. Unchanged context stays collapsed until Show full diff. n and p move between hunks. Nothing is highlighted until an arrow key, so Enter does not reject or approve by accident.

## Change review

A read-only run says that nothing is waiting for approval. A run with no activity yet says that changes and commands will show up here first.

## Errors and credentials

The attached session is the repro. On the zhivex-ai-sdk workspace, qwen3.6-flash ran “Haz un análisis de seguridad del repo”, made 135 read-only calls, and reported 1,803,551 tokens. The screen then showed:

- A red banner, “EXECUTION FAILED” and “Read the current session state before submitting another action.” The banner had no Reconcile action.
- The stream badge “Reconciliation required” and the line “The response was not confirmed. Reconnect before another action; nothing is retried automatically.”
- “Origin: no user thresholds. 0 steps · 135 tool calls · 1803551 tokens reported.”
- “Task evidence is unavailable. Refresh the host state before deciding. Ordinary chat may have no task contract.”
- Every `list files`, `search files`, and `read file` call as its own completed row.
- Change review saying “No changes to review. Requests show up here before anything runs.” even though the run had already read the repo.
- The composer still holding the same prompt, with only “Recover submitted text”.

A confirmed `EXECUTION_FAILED` now stays editable. The banner says “The task stopped” and tells the person to edit the message and send it again. The badge says “Error”, not “Reconciliation required”. Reconcile stays in the header for a lost response and only re-reads host state. It does not replay start, decide, or cancel. The checklist says to send a message or reconcile if a checklist should already be here. Read-only calls collapse into “Explored N files”. A read-only run says nothing is waiting for approval because the run is only reading files. The recovery card offers “Edit message” and “Send again”, and neither runs by itself.

## Sessions

The header is one 48px bar. The project and the session title share a baseline on the left. Connection and attention are a single control: a status dot and “Connected”, or “N needs you”, or Reconcile. Sessions, the limits control, a plus icon, and a theme icon sit on that same line at 32px. The theme control is an icon, not a “Dark” label. Narrow widths move the title onto its own row instead of letting controls overlap the corner.

## Finishing and resuming

After a failed send, the composer keeps the message. The recovery card says it is still there and offers “Send again”. “Edit message” puts the text back only when the composer was cleared. Neither runs by itself. Reconcile reloads the host snapshot.

## Theme

Hard-coded dark fills on buttons, cards, and headlines now use theme tokens. Light text and controls meet WCAG AA. Dark values for those controls stay the previous hex colors.

## Narrow widths

The header wraps the title onto its own row. The existing chat and review panes stay.

## Budgets and telemetry

Interactive web used to remove the engine ceilings, so one prompt could make 135 read-only calls and spend about 1.8 million tokens while the meter said “no user thresholds” and “0 steps”. Tool-only streams and a step index of 0 now count as at least one step. Web launches keep the engine ceilings (32 tool calls, 120,000 total tokens, 50 steps, 15 minutes) unless the launch sets a number. Read-only tools count. When the person has not set thresholds, the same stop values are applied to the visible meter and the existing cancel path. Stop requests cancellation. It does not promise a resumable pause. Context compaction stays on with the finite token ceiling.

## Gaps in `@zhivex-ai/react`

- Model picker. Proposed `ModelPicker` props: `models`, `configured`, `favorite`, `query`, `onSelect`, listbox keyboard handlers, and a truncated name with a tooltip.
- Workspace memory. Proposed `useWorkspaceModel(workspaceId)` that returns the last-used id and a setter.
- Session-creating send. Proposed `onSend` result `{ status: "needs-session" }` so the host can create a session without a second transport.
- Review decisions. Proposed `approveDisabled`, `preventEnter`, and a reason that is not sent as the harness ticket.
- Explored-file grouping. Proposed `groupActivity(entries)` that collapses consecutive read-only tool rows.
- Reconcile. Proposed `canReconnect` plus `reconnect()` that only re-reads and never retries a mutation.
