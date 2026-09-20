# HAR-HU-33 — Native Keychain host increment

Status: in progress. No acceptance criterion is closed by this increment.
Branch `feat/harness-desktop`; no push, publication or personal credential access.

`desktop/native/CredentialStore.swift` implements fixed-service/account generic
password storage for the desktop's current OpenAI provider. Native AppKit
`NSSecureTextField` captures a replacement key without a renderer input field.
Keychain operations support presence, replacement, deletion and host-only read;
OS errors are mapped to fixed statuses. A locked keychain is rejected before
access. New entries restrict their trusted application ACL to this executable;
other applications are not silently trusted. There is no secret argument, file
fallback or diagnostic echo. Delete is idempotent and rotation uses item update.

This uses macOS file-based Keychain APIs, some deprecated by Apple, to support the
current unsigned desktop candidate. It does not claim Data Protection Keychain
accessibility flags, iCloud sync or other-platform support. Signed helper identity,
ACL behavior across updates and package installation remain integration work.

The host TypeScript adapter bounds stdout, deadlines and process environment,
discards stderr, validates the response and returns fixed error categories.
Only host code can request the secret; this API must never be bridged to renderer.
Connection probing uses one GET to `https://api.openai.com/v1/models`, a ten-second
abort deadline and redirect rejection. It cancels the body and exposes only
connected, invalid credential, forbidden, rate limited or network failure.
Successful model listing does not certify generation or a specific model's access.

## Verification

- `swiftc` compiled the native helper with Security and AppKit.
- `bun run desktop/scripts/build-credential-helper.ts` reproduced the build in
  `desktop/build/credential-store` (run after the desktop build recreates build/).
- Native `self-test` passed against its own newly created temporary keychain:
  missing, save/read, rotation/read, lock/refuse, unlock/read, delete/missing and
  repeated delete. Random test values never appear in output. The test deletes
  the temporary keychain; it does not open the user's login keychain.
- Four Bun tests passed with 52 assertions. Coverage: restricted helper arguments
  and environment, host-only read, fixed bounded request and sanitized statuses,
  unsupported/locked/missing cases without network, malformed/oversized/crashed
  helper output and timeout. The network is mocked; no OpenAI API call was made.
- Desktop typecheck passed. An initial fixture failed because macOS canonicalizes
  its temporary directory; corrected the expected realpath. A test type mismatch
  was corrected with literal status types before the passing run.

## Remaining work

Integrate native build/copy outside ASAR, main/preload settings actions and native
prompt, provider credential injection through private runtime IPC, rotation/delete
coordination with active work, secret redaction before persistence, and packaged
journeys proving no secret in renderer/SQLite/logs/exports. Test invalid credentials
and locked-store recovery through the actual UI. Keep HU33 open until then.

## Primary references

- [Apple generic password attributes](https://developer.apple.com/documentation/security/ksecclassgenericpassword)
- [Apple macOS Keychain implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- [OpenAI API authentication example](https://platform.openai.com/docs/api-reference/backward-compatibility?lang=csharp)
