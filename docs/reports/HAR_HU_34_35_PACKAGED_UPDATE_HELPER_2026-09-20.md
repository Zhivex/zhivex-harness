# HU34/35: packaged native update lock helper

The build compiles `update-worker-lock` for arm64 macOS 13.0 and packaging copies
it into app Resources alongside the credential helper. Native release verification
now requires both helper-specific Developer ID identifiers under the app's pinned
Team ID, arm64 and hardened runtime. The new helper must be a real file; missing,
symlinked or signature-rejected helpers prevent acceptance.

The regenerated installer manifest includes SHA-256/size for the update helper and
checks its minimum OS target against the bundle. The installation smoke verifies
all installed hashes, detaches the DMG, then exercises the application, Keychain
fixture and handoff protocol with the installed helper and installed Electron.

Verified locally:

- Five native-verifier tests / 23 assertions; TypeScript and diff checks pass.
- Build succeeds. Packaging required network access outside the sandbox to fetch
  Electron; the initial sandboxed packaging attempt failed DNS resolution.
- `prepare-installer.ts` created and verified the DMG.
- `smoke-installer.ts` passed the full packaged app journey, credential helper
  self-test and native handoff. App evidence: `/tmp/har-electron-06gKF1/report`;
  installed handoff: `/tmp/har-handoff-report-1qof8W/report.json`.
- The actual unsigned package is rejected by the production verifier;
  `/tmp/har-mac-verifier-3FtIs9/report.json`.
- Packaged layout passes all four 1120/720px, settings open/closed cases;
  `/tmp/har-layout-f1Q6RO/report.json`.

DMG SHA-256: `db7117eb121770fa700226e22d72d60bf42bcc1927098f0b2a140988f7ddd54e`.
Update helper SHA-256: `7078d1eae0805594246c68545e066181cb16a6667f68770467b360451b3441cd`.
Full manifest/check are recorded in the accompanying JSON files. The manifest's
source reference is the pre-commit HEAD with workingTreeModified=true, not a claim
that the source was clean. Existing unrelated formatting changes remain unstaged.

The installed handoff test uses a fixture worker bundle and version verifier. It
proves the shipped helper and runtime can perform the protocol, not that main/UI
already exposes an updater or that a signed update was accepted. A production
worker entrypoint, main/UI and external state-owner exclusion remain pending.
Developer ID/notarization are deferred by user decision; all HU34/35 acceptance
criteria remain open. No /Applications modification, push or publication.
