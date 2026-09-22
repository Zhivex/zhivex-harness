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

- Welcome: original Zhivex mark, title and bounded project/model context beside it;
  narrow terminals stack the context beneath a compact mark.
- Composer: model, state, approval policy, attachment count, and keyboard hints are
  refreshed before each task. `/status` retains the full identifiers and configuration.
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
  restores those details. Tool actions, approval payloads, failures, usage and
  verification outcomes stay visible. This does not change machine output.
- Both direct and service consoles reuse input, history, help, composer and chooser
  presentation. Service-host authority and available commands remain explicit.

No prompt history is written to disk by the editor. During model execution or an
approval question, pasted or surplus input cannot become a queued approval. This
change does not introduce shell shortcuts or automatic approval-mode cycling.

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
