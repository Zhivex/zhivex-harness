# Console UX rationale

The interactive console keeps project context, task editing and consequential
approval decisions distinguishable within normal terminal scrollback.

## Reference patterns

Reviewed on 2026-09-21:

- [Codex CLI commands and shortcuts](https://developers.openai.com/codex/cli/slash-commands):
  searchable slash commands, an in-memory history search and saved-session selection.
- [Gemini CLI keyboard shortcuts](https://geminicli.com/docs/reference/keyboard-shortcuts/):
  discoverable keyboard help, multiline editing, and contextual list navigation.
- [Gemini CLI settings](https://geminicli.com/docs/cli/settings/):
  explicit presentation preferences separate from model configuration.

These references inform interaction patterns, not a claim of feature parity.

## Implemented behavior

- Welcome (`zhivex-code`): the full braille mark appears only when stderr is a
  terminal, `TERM` is not `dumb`, and the size is at least 48 columns by 24 rows;
  otherwise the mark is `( Z )`. Title and bounded project/model context sit beside
  the mark when the width allows, and stack beneath the compact mark otherwise.
  `NO_COLOR` removes color and leaves the glyph.
- Focus layout: one conversation column in normal terminal scrollback, with the
  original Zhivex mark. The welcome panel keeps project and model context; keyboard
  help lives beside the editor rather than repeating beneath the welcome panel.
- Composer: model and reasoning sit above the input, followed by state, approval
  policy and attachment count. A muted placeholder disappears when typing. A lower
  rule and width-aware keyboard hints follow the complete draft, including while
  editing an earlier multiline row. Command and history searches temporarily replace
  this footer. Submitting or cancelling removes the footer before streaming or
  asking for approval. `/status` retains the full identifiers and configuration.
- Commands: search descriptions as well as names; names matching the prefix rank
  first. Arrow selection and Tab or Enter on a partial command fill the draft.
  Executing a selected command requires a separate submission.
- History: Ctrl+R searches this process's bounded prompt history. Selection restores
  an editable draft; it never submits it. Literal pasted content retains that status.
- Editing: Up/Down move within multiline drafts and recall history at their edges.
  The installed Node runtime is verified using a PTY, including actual cursor edits;
  Bun's readline shim does not implement all native cursor operations.
- Navigation: `/menu` opens hierarchical, filterable menus. Up/Down selects, Enter
  enters or chooses, and Escape goes back. Providers lead to their model catalogs;
  browsing does not mutate runtime configuration. `/provider`, `/model` and `/resume`
  are direct entry points. Current and provider-default models are identified.
- Models: the CLI bundles an offline SDK catalog snapshot with provider revisions
  and source hashes. Chat-and-tools recommendations are suggestions, not live account
  access checks or Harness certification. Custom IDs remain supported. A generator
  refreshes the snapshot from an explicit SDK checkout, without adding a runtime dependency.
- Activity: direct chat omits routine provider/step notices by default; `/verbose`
  restores individual events for subsequent activity. Reads and searches use a
  temporary status and one summary at the run or approval boundary. Edits,
  failures, approvals and verification outcomes stay visible. Known failures
  use safe, actionable descriptions instead of an opaque tool error. This does not change machine output.
- Both direct and service consoles reuse input, history, help, composer and chooser
  presentation. Service-host authority and available commands remain explicit.

No prompt history is written to disk by the editor. During model execution or an
approval question, pasted or surplus input cannot become a queued approval. Background tasks remain separate from approval answers. This change does not
introduce shell shortcuts or automatic approval-mode cycling.

## Validation

`bun run smoke:console` runs offline PTY journeys against the built Node CLI for
setup, editing, history, approvals, resume, cancellation and local service transport.
Unit tests cover menu selection, literal-history restoration, label sanitization,
chooser filtering and presentation boundaries. Provider fixtures do not use live
credentials or make remote model requests.

## Progressive help

`zhx --help` focuses on everyday entry points. `zhx <command> --help` (including
nested subcommands) uses the command option contract to select relevant options.
`zhx help all` retains the complete reference. No execution or approval occurs
when opening help.

An empty slash search presents common actions. A nonempty query searches the full
supported catalog. `/help` keeps approval controls visible; `/help all` also shows
advanced actions. The service console still exposes only host-supported actions.

### Presentation references

The compact view follows the separation between conversation and optional tool
detail in [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)
and the grouped exploration presentation in
[Codex's terminal renderer](https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs).
Zhivex uses its existing `/verbose` toggle; this is not a retrospective transcript
viewer. JSON and JSONL keep their existing machine contracts.

## Activity and input during execution (2026-09-26)

The direct console displays separate phase and total elapsed times. Mutation tool
calls say **Preparing** until an authoritative result arrives; input-validation
failures explicitly say that edits were not applied. Committed workspace audit
entries produce file-by-file receipts with a `/diff` hint. These receipts do not
claim verification; check results and the final verification summary remain separate.
The service console displays host activity and applied-file receipts from its
validated final result, without inventing file paths missing from streamed events.

`/activity` replays up to 200 recent activity entries from this console process,
including preparation, tool outcomes, approval waits and applied-file receipts.
`/activity clear` clears that view. It does not retain raw tool inputs, file contents
or model reasoning, and switching conversations resets it. `/verbose` still controls
future rendering independently.

While a run is executing, the terminal editor accepts a background draft. Its
bounded preview appears in the transient activity line while that line is visible;
streamed prose takes precedence. Enter queues a task for after the active run,
Alt+Enter inserts a newline, and Up on an empty draft retrieves the last queued task.
An unsent draft is restored to the normal composer. `/queue` inspects pending tasks;
`/queue clear` discards them. The queue holds at most eight tasks and 256 KiB, with
64 KiB per draft. Overflow retains the draft. Ctrl+C stops the current operation
and clears its queue. Queued input is always literal task text, including slash
commands. It never answers approval or credential questions, and queued submission
pauses while a run is active or awaiting approval. Queue and drafts are in memory
only. They do not implement mid-request model steering or survive process exit.
