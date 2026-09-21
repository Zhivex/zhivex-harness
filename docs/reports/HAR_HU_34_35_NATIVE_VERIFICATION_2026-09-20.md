# HU34–35: native publisher gate and refreshed unsigned installer

`mac-application-verifier.ts` enforces a host-pinned Team ID and product identifier
with macOS `codesign --verify --deep --strict --all-architectures`. A separate
requirement protects the credential helper (`ai.zhivex.harness.credential-store`).
Both require Apple-anchored Developer ID Application certificates and hardened
runtime. Bundle metadata must match the expected full version and numeric bundle
versions; the main executable and helper must be arm64. `spctl` assessment must
succeed and report exactly one `Notarized Developer ID` origin. Local overrides,
unknown/ambiguous origins and command failures are rejected with fixed errors.
Commands are bounded by time/output limits and use macOS-shipped tools, without
adding Xcode as an end-user update dependency. Paths with control characters and
bundle/helper symlinks are refused.

The certificate requirement follows Apple's descriptions of requirements and
Developer ID OIDs: [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
and [Code Signing Tasks](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).
The gate relies on the OS for signature/notarization assessment, not custom
certificate validation. It must run against immutable staged bytes and again
where required by the final installer; it is not yet connected to that installer.

The packager now writes numeric `CFBundleShortVersionString` and `CFBundleVersion`
(`0.1.0`) and retains full SemVer (`0.1.0-alpha.1`) in `ZhivexDesktopVersion`.
Installer preparation validates all three fields. Concurrent formatting in the
packaging script is preserved outside the semantic change.

## Verification

- Four policy tests / 19 assertions and desktop TypeScript passed. Positive
  identity/notarization replies are command fixtures, not a real signed app.
- `bun run desktop/scripts/smoke-mac-verifier.ts` exercised actual codesign against
  the local unsigned/ad-hoc package and confirmed rejection with a fixture Team ID.
  Evidence: `/tmp/har-mac-verifier-isenRs/report.json`. No production identity is
  configured. A real signed/notarized positive case remains unverified.
- Gatekeeper assessment flags were checked read-only against the system Calculator
  app: accepted with `source=Apple System`. This only verifies the command path;
  the Harness gate would not accept that origin/identity. Assessment required an
  unsandboxed test call; no macOS policy was changed.
- The app and DMG were rebuilt. `smoke-installer.ts` verified artifact bytes,
  mounted/copied the app to temporary Applications, detached the DMG, then passed
  the complete runtime/renderer smoke and native credential-helper self-test.
  Evidence: `desktop/out/installer/installation-check.json`, copied into the report.
- All four packaged layout checks passed at 1120/720 pixels with settings open
  and closed (`/tmp/har-layout-UmWKZs/report.json`).

## Current local artifact

`desktop/out/installer/Zhivex-Harness-0.1.0-alpha.1-darwin-arm64-unsigned.dmg`

SHA-256: `ba95dc0983a40129831288938c2e096ae6cea8daf34fd7cef26a7ecc58ba0e42`
Size: 141395030 bytes. This replaces the earlier local DMG; historical reports
retain their earlier hashes. Current manifest and installation evidence are
committed as `HAR_HU_34_35_REFRESHED_INSTALLER_*_2026-09-20.json`.

Signing/notarization remain deferred by user decision. Installed fixture success
does not establish Gatekeeper distribution acceptance. The verifier is not wired
to main/UI; actual install/binary rollback and the complete update flow remain
open. No push or publication. HU34 and HU35 acceptance boxes stay open.
