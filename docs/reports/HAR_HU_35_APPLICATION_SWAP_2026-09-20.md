# HU35: recoverable application bundle replacement

`application-swap.ts` stages the verified candidate in a private sibling directory
on the installation volume, preserving framework symlinks. Bundle traversal rejects
external links/special files and limits depth, entries and total bytes. Staged files
and directories are synced before the private journal is published. Preparation
does not modify the installed application and cleans its own incomplete staging.

Activation requires stopped-owner confirmation and revalidates both bundles before
recording `swapping`. Two same-volume renames retain the previous app and publish
the staged candidate. The installed path is verified again before recording
`installed`. Failed or interrupted activation requires rollback rather than replaying
the install. Rollback verifies the previous bundle, preserves the failed candidate,
restores the old path and verifies it. It can resume after either rename boundary,
including a crash after the original app was restored but before journal completion.
No previous/failed bundle is deleted by activation or rollback.

The default verifier is the native Developer ID/notarization gate. Version/team
policy and paths must be supplied by the trusted host, derived from the signed
manifest and current installation. The candidate must remain immutable while
preparing. This component neither launches the replacement nor elevates privileges;
the host/worker must stop owners before calling it. A worker surviving main-process
exit and integration with state recovery/coordinator/UI are still required.

## Verification

`bun test desktop/tests/application-swap.test.ts`: **6 pass, 26 assertions**.
Desktop TypeScript passed. Fixtures cover successful replacement/rollback,
interruption after each activation/rollback rename, unconfirmed owners, staged
tampering, post-install verification failure, external-link rejection and internal
framework-style link preservation.

`bun run desktop/scripts/smoke-application-swap.ts` passed using two temporary
copies of the actual unsigned Electron package. The candidate changes its fixture
version metadata; both copies use the same built runtime bytes. An explicit fixture
verifier checks metadata/ASAR identity in place of the production native-signature
gate. The test replaces the temporary app, interrupts rollback after quarantining
the candidate, retries from the journal and verifies the restored ASAR. It then
opens the restored app with a clean fixture profile and passes the complete
conversation/approval/cancellation/crash-recovery smoke. Neither temporary bundle
is running during the renames. No real /Applications or personal profile is touched.

Evidence: `/tmp/har-bundle-swap-report-p2kMbC/report.json` (committed JSON companion),
with restored-app smoke at `/tmp/har-electron-BoKrv5/report`. This proves actual
bundle filesystem operations and a runnable restored app, not acceptance of a
signed next release. Signing/notarization remain deferred. Main/UI and durable
coordination of binary plus state recovery remain open; HU35 criteria stay open.
No new published artifact, package rebuild, push or release.
