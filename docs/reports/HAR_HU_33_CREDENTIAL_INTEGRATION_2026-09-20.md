# HAR-HU-33 — Desktop configuration and private runtime bootstrap

Status: in progress; acceptance remains open. No push/publication.

The desktop now exposes four sender-validated credential actions: presence,
native configure, delete and bounded probe. No IPC method returns or accepts a
secret. The AppKit helper owns key entry; the renderer displays only fixed status
messages. Fixture mode returns unsupported and never accesses a personal keychain.

A coordinator blocks concurrent work admission, pauses all current runtimes,
refuses active work without cancelling it, and closes old credential holders after
saved/deleted or uncertain results. A failed close keeps work blocked. Existing
tracked operations prevent credential mutation; shutdown awaits accepted changes.
Reopen the project after a change to start a new runtime with the current key.

The host reads Keychain and passes the key through private utility-process IPC.
It is absent from worker argv and process environment; provider construction uses
an explicit environment object. Renderer and client activity redactors receive
the known key. The build compiles Swift and packaging copies the executable into
Resources outside ASAR. Signature/ACL identity across updates is not yet certified.

## Evidence and limits

Eight host/coordinator tests pass with 68 assertions; desktop typecheck passes.
Coordinator tests verify ordered pause/change/close, refusal of active work,
concurrent requests and fail-closed behavior when an old worker cannot close.
Native build and temporary Keychain evidence remain in the preceding host report.
The eight tracked integration files compile to identical Bun-minified output in
the tested working copy and the staged increment excluding concurrent formatting.

End-to-end secret persistence coverage, actual native prompt interaction,
invalid/locked credential UI journeys and restart recovery remain to be completed.
In particular, client activity redaction alone does not prove that raw core stores,
file/tool results or export paths never retain a key. Do not close HU33 based on
these tests. GitHub credential storage remains host gh, separate from this OpenAI
provider setting. No provider request or personal secret read was performed.

The development smoke timed out at its 90-second deadline during crash recovery;
a package build overlapped that attempt. The isolated packaged regression then
passed, including recovery, renderer isolation/bridge allowlist, approvals and
project isolation. See HAR_HU_33_INTEGRATION_REGRESSION_2026-09-20.json and candidate
ASAR/helper hashes in HAR_HU_33_INTEGRATION_CANDIDATE_2026-09-20.json. This general
fixture does not configure a real credential or prove secret persistence safety.

The packaged Resources/credential-store executable also passed its native
self-test against a temporary keychain after packaging.
