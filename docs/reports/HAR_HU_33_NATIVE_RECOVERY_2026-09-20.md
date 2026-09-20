# HAR-HU-33 — Native dialog, recovery UI and export checks

Status: in progress. No personal credential access, live API call, push or publication.

The packaged native helper now has an isolated `self-test-ui` command. It creates
its own temporary keychain and random values, exercises the production AppKit
secure-field dialog, then removes the keychain. Only this explicit self-test
supplies synthetic input and clicks dialog buttons; configure has no automation
argument. Cancellation preserves the previous key, invalid input is rejected
without replacement, and a valid replacement is read back. The same test verifies
lock/refusal, unlock/read, deletion and repeated deletion. Both standalone and
packaged native binaries returned native-ui-test-passed.

The actual packaged React settings are exercised separately with a simulated host:
missing, cancelled save, saved presence, invalid credential, replacement, successful
bounded probe, locked/unlocked status and deletion. The renderer has no secret input,
read-secret bridge method or credential storage. This checks actual labels/actions
and recovery, but does not pretend the simulated host is native Keychain.
Run: `bun run desktop/scripts/smoke-layout.ts --packaged --credentials`.

A further gap was fixed: Git managers created before a key was read from Keychain
held an old sensitive-value snapshot. Host sensitive values now use a live registry;
validated helper reads register values, including the read following a successful
native save. Existing redactors and Git reviewers reject newly learned values and
retain prior registered values for late results after rotation. This remains
process-private and is never serialized to the renderer or disk.

Persistence evidence now includes run inspection and a real state backup after
settling the rejected fixture run, alongside SQLite/WAL and state-file scans. The
synthetic key is absent from both exports. Existing ordinary writes and later safe
runs continue to work.

## Validation

708 tests passed, zero failures, 4087 assertions across 99 files. Desktop typecheck
passed. The macOS unsigned package rebuilt. Packaged renderer credential checks,
layout checks at 1120/720px open/closed, and native secure-dialog test passed.
No live model generation or authentication certification is claimed.

## Remaining closure evidence

The native helper, host adapter, runtime guard and renderer are verified at their
respective boundaries. A single packaged native-Keychain-to-host-to-runtime journey
with fixture credentials remains before closing the full HU33 acceptance. Signed
helper identity across updates remains part of deferred distribution/update work.
