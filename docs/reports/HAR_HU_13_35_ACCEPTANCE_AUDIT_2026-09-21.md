# HAR-HU-13–35 acceptance audit

Review of checkout `0191246`, updater implementation `70b04a1`, branch `feat/harness-desktop`. Notion consulted again for all 23 HUs; their 69 criteria are listed in this audit's JSON with corresponding evidence. No push, publication or new provider calls.

## Result

| Scope | Verified result | Pending |
| --- | --- | --- |
| HU13–20 | Implemented and marked Done / Pending publication in Notion. Installed CLI package, first use and PTY revalidated. Dataset and 22 preserved attempts match the report. | The pilot produced HOLD: 6/10 correct in both artifacts; this does not enable release or certified daily use. |
| HU21–25 | Contract, service, replay and CLI implemented. Notion retains all 15 closed criteria. Installed-package smoke includes reference client and service. | No publication. |
| HU26–30 | Desktop alpha implemented; separate runtime, conversation, approval and recovery covered by reports and the current increment's installed smoke. Four current-package geometries pass. | No general provider/OCI certification or signed beta. |
| HU31–33 | Worktrees, Git/PR delivery and keychain implemented. Current package again passes two concurrent tasks, restart, unique commit/push/PR, lost-response recovery and reviewed cleanup. | Simulated GitHub and local Git remotes; live authentication is not certified. |
| HU34 | Local DMG prepared, installed and verified; versions, hashes and documentation preserved. | Developer ID, notarization and signed-distribution acceptance explicitly deferred by the user. |
| HU35 | Query/download/install/restart/recovery connected. Backup, failures and access controls have local evidence. | Real trust configuration and positive demonstration of signed update/recovery. Build continues disabling updates without that configuration. |

HU34–35 remain In progress / To verify in Notion. Component tests, ephemeral keys and simulated signature verification do not substitute for their criteria. Requested local preparation advanced, but the full objective is not demonstrated.

## Completion checks

- `bun run docs:check`: 111 files; passed.
- `bun run contract:check` and `bun run typecheck:tooling`: passed.
- `bun run migration:check`: published fixtures 0.10.0/0.11.1 passed.
- `bun run build` and `bun --no-env-file run smoke:artifact`: passed. The script includes PTY, first use, client contract and service against the installed package. It uses offline providers.
- `bun run --cwd desktop smoke:worktrees:packaged`: passed; evidence `/tmp/har-tasks-USYWyg/report` and result preserved in audit JSON. Test pushes target a temporary bare repository; the implementation branch was not pushed.
- `bun run desktop/scripts/smoke-layout.ts --packaged`: sidebar/content correct at 720 and 1120 pixels, with panel open and closed. Report `/tmp/har-layout-XSfX5b/report.json`.
- Installation manifests from the previous increment identify DMG SHA-256 `0fd6156ca88bb6422287dbc3cbedb00ed98fcdb785e1ece9285d3e4e95625404` and temporary installation with the image unmounted.

## Completion boundary

Signing/notarization were deferred by the user. Creating identities, inventing trust values, publishing a feed or bypassing native checks to declare those HUs closed is inappropriate. The signed-completion blocker remained throughout recent increments and the audit. That decision is unchanged and authorization already settled is not requested again.

SQLite exclusion protects current clients participating in the protocol; it does not certify old clients or unrelated direct libraries. This is an explicitly preserved limitation, not evidence of universal exclusion. Current format is 1 and incompatible formats are rejected; no migration for an unimplemented future schema is promised.

User formatting changes in `desktop/src/ReviewPanel.tsx` and their `output/` directory are preserved without incorporation.
