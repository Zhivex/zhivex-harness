# Desktop UX · 2026-09-21

Final result: passed.

## Reference and scope

Adaptation of the existing Harness desktop, using the local Zhivex AI Chat `/demo` as the visual reference requested by the user. `git pull --ff-only` reported the reference was up to date at `9fb640b67e54c76dcb497e1acc7989d3991c5a33`; that checkout remains clean.

Compared the reference and implementation together at **1120 × 728 content pixels**, both in dark theme with an empty conversation. Electron's outer window is 1120 × 760; the 32 px macOS title bar is excluded. The compact Electron window is 720 × 520, with a 720 × 488 content viewport. Screenshots are 1×. Harness uses an isolated offline fixture repository; project tools, credentials and approvals are intentional product differences from the web demo.

- [Reference](design-evidence/zhivex-chat-reference.png)
- [Packaged Harness](design-evidence/harness-welcome.png)
- [Model selector at 720 px](design-evidence/harness-models-compact.png)
- [Packaged UX verification](design-evidence/ux-verification.json)

## Findings and fixes

- **P1, resolved:** bundled font URLs were data URLs, initially blocked by the desktop CSP. Allowed embedded fonts only in `font-src`; renderer scripts, connections and frames retain their existing restrictions. Both local font families load in the packaged app, verified with `document.fonts.load/check`.
- **P2, resolved:** closing the model picker did not explicitly return keyboard focus to its trigger. The close path now restores focus and discards unconfirmed model changes; Escape and return focus pass the Electron UI test.
- **P2, resolved:** the empty conversation inherited message auto-scroll, moving the welcome content upward. Empty activity now starts at the top, and the welcome layout centers when space permits. Recaptured and compared against the reference after the fix.
- **P2, resolved:** a short window could initially hide model confirmation below the catalog. Dialog actions now stay visible while the catalog and configuration content scroll. The test asserts the Apply button is inside the compact viewport; the final screenshot confirms this.

No unresolved P0/P1/P2 differences in the reviewed scope.

## Fidelity review

- **Typography:** locally packaged Inter and Space Grotesk match the reference families. Space Grotesk provides heading hierarchy; body text, labels and controls use Inter. Long conversation titles truncate; model IDs truncate in the compact trigger and wrap in the catalog. Repository content retains safe wrapping.
- **Layout and spacing:** 252 px sidebar at the normal size, centered conversation and composer, compact toolbar and three suggestions. At 720 px the sidebar is 192 px and can be hidden; message and sidebar content scroll independently of the composer. In a short window, welcome suggestions may require scrolling. No horizontal overflow or obscured send control.
- **Color:** neutral dark backgrounds, lavender primary actions, subtle purple borders, muted secondary text, distinct error and diff colors. The original green-tinted shell has been replaced. Focus outlines remain visible.
- **Assets:** Lucide icons match the reference's icon family. No raster imagery was required or replaced with handmade graphics. Fonts are bundled; no external font request is necessary.
- **Copy and content:** Spanish product copy is tailored to repository work. Suggestions populate the editor without executing. Existing technical evidence and approval text remain available. Harness deliberately keeps Git delivery, isolated tasks and credential settings instead of copying demo-only controls.
- **Interactions:** searchable conversations, collapsible navigation, searchable model catalog, custom model IDs, explicit application/cancellation, native dialog focus containment, Enter to send, and Shift+Enter/IME guards. Git and task panels remain native disclosures above the conversation.

The full-view comparison provided readable typography and spacing evidence. The compact model-dialog capture additionally verifies the small controls, selection state and persistent actions.

## Validation

- Desktop and root TypeScript checks passed; documentation check passed.
- `bun test desktop/tests`: **165 passed, 0 failed**.
- Packaged model smoke passed: four existing providers, persisted model binding, custom model, renderer reload, approval blocks switching, unsupported provider rejected.
- Packaged UX smoke passed: suggestions only fill, conversation search, sidebar visibility, model search, Escape restores selection, keyboard focus return, Enter submission, Shift+Enter/IME guard, bundled fonts and compact layout.
- Packaged conversation smoke passed: streaming, cancellation, file approval/rejection, decision history, process recovery, duplicate submission prevention, redaction and literal repository text.
- Credential settings UI smoke passed with a fixture backend; no real credentials were read or changed.
- Update settings UI smoke and sidebar geometry checks passed.

This run verifies the redesign with offline model/backend fixtures. It does not constitute a new live-provider certification. Signing/notarization remain outside this UX change.

## Implementation checklist

- [x] Use the requested reference and preserve Harness-specific functionality.
- [x] Compare source and rendered implementation together, then recapture after fixes.
- [x] Verify normal and compact layouts, keyboard behavior and approvals.
- [x] Package the desktop locally; do not push.
