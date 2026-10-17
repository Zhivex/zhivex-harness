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

## Change review

A read-only run says that nothing is waiting for approval. A run with no activity yet says that changes and commands will show up here first.

## Errors and credentials

Confirmed host failures, including `EXECUTION_FAILED`, used to lock the session as if the response had been lost. The banner said “EXECUTION FAILED” and “Read the current session state before submitting another action.” There was no usable reconcile control in the light theme. A confirmed failure now stays editable. The banner names what happened and the next action. A lost response still requires Reconcile, which only re-reads host state and does not replay start, decide, or cancel.

## Sessions

The header is one bar: project and editable session title, one connection or attention control, then Sessions, limits, a new-session icon, and a theme icon. “New session” is no longer repeated as a second title.

## Finishing and resuming

After a failed send, the composer keeps the message and offers “Edit message” and “Send again”. Neither runs by itself. Reconcile reloads the host snapshot.

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
