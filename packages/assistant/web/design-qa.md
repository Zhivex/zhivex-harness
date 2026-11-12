# Assistant web — design QA

Verified 2026-11-11 in the in-app browser. Reference: approved generated mockup
`exec-ba173b98-d405-41a4-92e5-3b6ad5afd3d4.png` (1586 × 992).
Reference and implementation were inspected together in one comparison output.

## Visual acceptance

- P0: none. Main composition, left navigation, greeting, metrics, agenda timeline,
  approval card, automation card and composer match the selected direction.
- P1: none. Desktop hierarchy, warm canvas, dark green actions, amber conflict,
  rounded borders and card proportions retained. Mobile tested at 390 × 844:
  cards stack, controls remain reachable, no horizontal overflow observed.
- P2: none outstanding. Typography and vertical spacing adjusted after first
  capture. Desktop evidence: `qa/desktop.jpg`; mobile: `qa/mobile.jpg`.
- Intentional differences: truthful counts (4 events/1 automation), explicit demo
  label, neutral owner icon instead of an invented personal photo, generated Z
  logo, and a review-details step before an exact approval. Reject is in the
  review dialog. Conflict label does not claim an uncalculated duration.

## Behavior verified

- Approval opens a native modal, with confirmation gated by explicit review;
  demo approval clears the pending item and reports a simulated outcome.
- Invalid IANA zone shows an error inside the modal. Valid save changes the daily
  schedule to 08:30. Pause updates the active count; desktop final capture resets
  demo data intentionally. Fixed form submission to read the submitted fields.
- Composer transitions to Conversations and shows the simulated reply.
- Mobile menu navigates to Models/modules; connection page reports demo state.
- Browser error log empty. Viewport override reset; preview marked deliverable.

## Integration acceptance

Isolated installed consumer: 53 tests pass, 307 assertions, no failures; TypeScript
and production build pass. HTTP tests use a real local host and cover auth,
Host/Origin isolation, static symlink escape rejection, message deduplication,
conversation recovery/token rotation, exact review revalidation, single effect,
and incomplete agenda rejection. Provider/Calendar/Telegram calls in these tests
are offline mocks. No live account modification was performed.

## Product limits

Single local owner and assistant. Connections and model/module configuration are
informational in this UI; authorization/config changes use documented host flows.
Conversation display is bounded to recent runs and outputs. The demo is in-memory
and cannot contact production services. Multi-agent configuration remains future work.
