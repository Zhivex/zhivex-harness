# HAR-HU-33 — Local acceptance closure

Implemented and verified locally for the desktop's OpenAI credential on macOS.
Publication remains pending by user instruction. No implementation-branch push,
real provider call, personal credential access, signing or notarization occurred.

## Acceptance audit

| Requirement | Authoritative evidence |
| --- | --- |
| Store/delete using macOS secure storage | Production Swift Security/AppKit helper; packaged self-test-ui uses a real temporary keychain and the same secure-field, save/read/update/delete functions. |
| No credential in SQLite, logs, renderer or exports | Private host pipe and utility-process bootstrap; no credential argv/process env; fixed errors and discarded helper stderr; known-key SQLite SQL/binding guard; raw DB/WAL/state scans, inspection and backup tests; live host redaction for Git previews; integrated renderer/storage scan. |
| Presence and bounded probe without revealing secret | Four secret-free preload actions; fixed OpenAI models GET, ten-second deadline and redirect rejection; native entry outside renderer; packaged UI fixtures for all status messages. |
| Locked store, rotation and invalid credential recovery | Native temporary-keychain lock/unlock and cancelled/invalid/replacement dialog tests; HTTP rejection/probe tests; coordinator refuses active work and closes old holders; integrated runtime restart with a different native key and conversation recovery. |
| Other OS backends unsupported | Host adapter returns unsupported before spawning/reading; unsupported-backend tests. |

## Integrated package journey

`bun run desktop/scripts/smoke-native-credentials.ts` bundles a host runner using
production launchProjectRuntime and openCredentialStore, and loads runtime/preload/
renderer from the packaged ASAR plus its packaged native helper. The native helper's
explicit self-test-read mode creates its own temporary keychain, saves/rotates a
random key, reads it, verifies lock/unlock and deletes the keychain before returning
that read value over its private stdout pipe. The wrapper contains only the helper
path and fixed test command, never credential bytes.

The host validates that response and passes the key by utility-process IPC. A
fixture-only digest comparison proves the runtime received the same value and
reports only booleans for equality and absence from argv/environment. No fixture
helper path or proof is exposed through the renderer bridge or normal app input.

The actual renderer creates a conversation and completes a mock-model run. The
runtime closes, reads another random key from a new native temporary keychain and
restarts against the same state. The conversation is recovered. Both native values
are absent from renderer text/storage and every file in state/profile directories.
The test exits cleanly with no provider network request.

Report: HAR_HU_33_INTEGRATED_2026-09-20.json. Initial test-runner invocation used
positional IPC arguments instead of the preload's object payload; this fixture bug
was corrected before the passing journey. It was not a production IPC change.

Supporting evidence: HAR_HU_33_KEYCHAIN_HOST, CREDENTIAL_INTEGRATION,
PERSISTENCE_BOUNDARY and NATIVE_RECOVERY reports dated 2026-09-20. The earlier
integration gaps recorded there are historical and superseded by this closure.

## Practical limits

Keychain APIs used here target the macOS file-based keychain. No other OS or live
OpenAI account is certified. Known literal/JSON-escaped secrets are blocked; this
is not arbitrary-encoding detection or historical-data scrubbing. Fixture models
exercise storage and IPC without making paid/live requests. Signed helper identity
across installs/updates belongs to HU34/35 and remains deferred with distribution.
The app and helper remain unsigned; hashes identify bytes, not publisher trust.

Final validation: 708 tests passed, zero failures, 4087 assertions across 99 files;
root/tooling/desktop typechecks, contracts and documentation passed. Both staged
runtime projections match the tested working files under Bun minification, leaving
unrelated concurrent formatting outside the commit.
