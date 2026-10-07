# Optional limits: visual and functional QA

Approved reference: Library `libfile_bcc0c7c053f881918c51335c67b4dc3e`,
`configuracion-gradual.png`, materialized and inspected locally before implementation.
The approved action change is **Avisar / Detener**. Detener requests existing
cancellation; it does not promise a resumable pause or financial reservation.

## Visual comparison

Compared actual PNG pixels with the reference at **1487 × 1058**, same open-modal
state: Próxima tarea selected, Gasto estimado expanded, unchecked activation,
empty disabled amount, remaining sections collapsed. The real modal retains the
688px width, charcoal surfaces, violet scope/save buttons, heading hierarchy,
accordion rows, separate permission note and recorded-consumption footer.

Intentional adaptations:

- Keep the repository's original Zhivex logo, workspace/session navigation and
  composer. The generated reference navigation is not implemented.
- Center the modal in the real viewport. Its extra technical-controls paragraph
  increases height by approximately 44px; it explains the controls that remain.
- Replace Pausar with the authorized Detener action and describe observed
  thresholds rather than guaranteed maxima. Cost remains explicitly estimated.
- Show independent step and tool-call inputs in their shared section.

Fixed during QA: title size/weight, keyboard focus escaping the modal, screenshots
extending beyond the mobile viewport, and wording implying a hard token/time cap
for notification-only thresholds. No remaining P0/P1/P2 visual discrepancy found
within the reviewed states. This is a manual comparison, not an exact pixel match.

Real browser captures:

- `web-limits-desktop-dark.png`: default modal, 1487 × 1058.
- `web-limits-controls-desktop.png`: distinct step/tool controls, 1487 × 1058.
- `web-limits-mobile-dark.png`: project controls, 390 × 844.
- `web-limits-mobile-footer.png`: scrolled footer and reachable actions, 390 × 844.

Existing Web supports only the dark color scheme; it has no light-theme selector.
No separate light theme was invented. Existing layout checks also cover widths
320, 390, 768, 1280 and 1440 without horizontal overflow.

## Functional evidence

The offline browser suite passes 28 journeys with zero browser errors. Coverage
includes open/close/Escape/cancel, no-change save without mutation, keyboard Space
activation, rejected fractional token counts, aria-invalid feedback, project
refresh persistence, distinct step/tool values, mobile scrolling and 24 Tab
transitions contained within the dialog. Focus returns to the launcher.

Composer journeys cover slow success, approval pause, failure, edits with identical,
different or cleared text, double click/Ctrl+Enter, session/workspace changes,
uncertain admitted requests and explicit recovery without overwrite or replay.
The draft is consumed under the synchronous dispatch lock, before any await.

Web unit/integration tests: 69 pass. Code tests: 129 pass. Initial aggregate offline tests:
2022 pass, 1 intentional unsupported-platform skip, 0 fail. Typecheck, lint,
architecture, documentation and stable-contract checks pass with the candidate SDK.
Real SDK execution exceeds the old numeric step/tool/token/time ceilings while
preserving per-operation and state/security controls. Legacy and new pending runs
survive restart and approval resume with their original SDK fingerprints.
An additional real-SDK regression verifies that unbounded Web execution retains
the `maxToolErrors: 4` guard and rejects when the existing SDK detects its
violation. Its receipt-based observation semantics remain unchanged. Terminal's
separate 20-error default remains unchanged.

Installed Web and CLI packages pass their offline consumer suites using the
versioned, digest-verified SDK fixture described in `docs/WEB_LIMITS.md`. No paid
provider calls or real session/database changes were used. After publication, official npm Core/SDK 1.31.0 and Agents 1.11.0 were verified
against registry digests and release provenance (`a7905584`). Their dist bytes match
the fixture. Minimal Core/Agents consumer pins are updated; final checks use real
publications without fixture overrides. Release policies and gate enforcement remain intact.
