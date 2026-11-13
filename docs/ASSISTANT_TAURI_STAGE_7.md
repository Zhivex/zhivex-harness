# Tauri stage 7: packaged local pilot and gradual cutover

The native application remains a **local pilot**, not a production distribution. This
stage adds installed-bundle checks, an integrity inventory, actionable prerequisite
inspection and conservative migration tooling. It does not retire Code or the Electron
Desktop application, copy Electron's updater, or change existing runtime identities.

## Supported target and prerequisites

The native pilot is enabled only for **macOS arm64 (Apple Silicon)**. Intel macOS,
Windows and Linux remain unsupported until their native permission, PTY, keychain,
lifecycle and package suites pass. The validation report records the actual tested OS;
this is not a claim of certification across every macOS version.

The bundle includes Node and production dependencies. Users do not need Bun or a system
Node to launch it. Git is required for projects/worktrees and Git delivery. Install Git
or Apple's Command Line Tools, then restart the app if the prerequisite check fails.
Provider setup requires a working system keychain, a model-enabled credential and quota.
The native shell uses local execution: reviewed commands run on this Mac. An OCI setup
requires its own configured runtime/image and never falls back to local execution.
Chromium is optional for the core workflow and required for stage-6 verification. With
`PILOT_RUNTIME` set as below, install the exact browser version explicitly using:

```sh
PILOT_RUNTIME="/Applications/Zhivex Assistant.app/Contents/Resources/runtime"
"$PILOT_RUNTIME/node" "$PILOT_RUNTIME/node_modules/playwright/cli.js" install chromium
```

The **Piloto local y compatibilidad** panel is available during onboarding and in the
project workspace. Its offline check distinguishes availability from actual verification:
loading the keychain adapter does not certify keychain access, and finding Chromium does
not certify browser execution. It never reads saved credentials or contacts a provider.
Existing setup errors provide the follow-up for locked keychains, rejected credentials,
missing quota, unavailable models and unreachable providers.

## Bundle integrity and installed pilot

The packager stages only five declared host entrypoints, the built web assets and
production dependencies. Stale developer scripts from `dist` do not ship. Dependency
`.bin` shims are omitted because Tauri dereferences their links while bundling; installed
commands use explicit module paths instead. `pilot-manifest.json` records the inventory,
SHA-256 digests, engine version, bundled Node version, architecture and build timestamp.
The native host verifies that inventory before opening user state. Added, missing,
modified or externally linked files fail closed with a reinstall diagnostic.

```sh
"$PILOT_RUNTIME/node" "$PILOT_RUNTIME/dist/pilot/cli.js" doctor
"$PILOT_RUNTIME/node" "$PILOT_RUNTIME/dist/pilot/cli.js" verify
```

A matching inventory detects accidental corruption and mixed builds; it is **not** proof
of publisher identity or a trusted update channel. Production distribution still needs
Developer ID signing, notarization, trusted update metadata and a separately tested
rollback procedure. No updater, remote update endpoint or automatic cutover is installed.

`smoke-pilot-installed.mjs` runs under the packaged Node with a runtime copied outside the
checkout. It exercises a real temporary keychain entry (removed afterwards), a simulated
provider, project tools, reviewed edits/checks, approval recovery after restart, public
Code service attachment, real Chromium evidence and shutdown. The fresh bootstrap smoke
also exercises authentication, duplicate ownership and parent-pipe EOF. Native shell/PTY
interaction is checked separately; headless Node tests are not labeled native UI tests.

## Migration preflight and adoption

1. Finish or reconcile active work under its original owner, then close that owner.
   Do not force-transfer approvals or replay uncertain effects.
2. Export using Code's existing `state export` with the original workspace, state directory
   and exact tenant/user/namespace flags. The engine refuses active runs, pending approvals
   and unresolved journals. Keep that private export and the original state untouched.
3. Run the pilot preflight against the export:

```sh
"$PILOT_RUNTIME/node" "$PILOT_RUNTIME/dist/pilot/cli.js" preflight \
  --workspace /absolute/project --backup /absolute/private/backup.json --owner local-owner
```

`local-owner` is the native managed Assistant owner. A CLI host with a different owner must
use that exact identity. Preflight uses Code's public backup/import contract in dry-run
mode. It checks schema, checksum, terminal state, canonical workspace and durable scope;
it does not migrate a live database or modify the target. Its report includes record
counts, credential-reference guidance, eligibility and a digest-bound receipt.

4. Only a compatible backup and an absent target are eligible for adoption:

```sh
"$PILOT_RUNTIME/node" "$PILOT_RUNTIME/dist/pilot/cli.js" adopt \
  --workspace /absolute/project --backup /absolute/private/backup.json \
  --owner local-owner --receipt DIGEST_FROM_PREFLIGHT
```

Adoption rechecks the receipt, acquires Assistant's project-owner lock, exclusively creates
`.zhivex-harness/assistant`, and fsyncs a private copy of the source backup and receipt under
`.zhivex-harness/migration-UUID` **before** transactional import. It never merges or
replaces an existing target. A failed import preserves the archive and target for diagnosis;
it does not delete either or retry automatically. A lost response must be inspected via
the archive/target, not blindly retried. The original export and store remain unchanged.

Default Code/Desktop scopes generally differ from Assistant's fixed scope. These histories
are intentionally **ineligible**: keep them in the original product and start new isolated
Assistant tasks. There is no scope-rewriting flag. Existing compatible Assistant exports
can be adopted; this does not promise resumability of historical runs under changed model
or runtime fingerprints. Only terminal history is eligible.

Credential references are not credentials. Migration copies no keychain entries or provider
keys and does not rewrite Desktop's references. Assistant binds its keychain account to the
canonical host directory; retain the existing `~/.zhx-app` location during binary upgrades.
Reconnect the desired provider through Assistant if importing history from another product.
Do not rename/move the host state directory as a substitute for credential migration.

## Gradual cutover and rollback matrix

| Surface / gate | Pilot policy |
| --- | --- |
| New project work, approvals, checks and terminal | Opt-in Tauri use after installed/native fixtures pass |
| Existing Assistant state | Preserve scope, provider binding and tool fingerprint; no format conversion in this stage |
| Compatible terminal exports | Reviewed preflight, private durable backup, empty-target import only |
| Incompatible Code/Desktop history | Remains in its original product; no automatic conversion |
| Code command and service attachment | Retained compatibility path; no composition retirement |
| Worktrees, local Git delivery, static previews | Retain stages 5–6 boundaries and their separate evidence |
| Real provider coding | Passed authorized OpenAI fixture: reviewed edit/check, 6,296 tokens; separate from offline package tests |
| Authenticated push/PR and external integrations | Unverified unless separately evidenced |
| Production signing, notarization, updates, rollback | Release blockers; not inferred from a local build |
| Intel macOS / Windows / Linux | Unsupported |

This release does not upgrade the engine state schema. For rollback of the local pilot,
quit through the controlled lifecycle, retain both state and private backups, and restore
the previous **complete** app bundle. Do not mix runtime files or downgrade a schema changed
by a future release. If compatibility is unknown, keep the state untouched and use the
original Code/Desktop owner. Successful migration fixtures are not proof of arbitrary
cross-version downgrade safety.

## Live gate and validation evidence

`scripts/verify-pilot-provider.ts` is prepared for an explicitly authorized OpenAI fixture:
it accepts only the configured `https://api.openai.com/v1` destination, sends a small
synthetic coding task, and permits only the reviewed replacement in `answer.txt` and its
exact test command. It reads the configured key from the keychain without printing it,
limits steps/tokens/time, and removes its temporary project. The initial automatic approval
review required explicit authorization for provider egress. After the user authorized the
OpenAI destination and a 16,000-token ceiling, the live journey passed with `gpt-6-luna`: four
HTTP 200 responses, two reviewed approvals, the expected edit and a check exit code of zero.
Reported usage was 5,816 input + 480 output = 6,296 tokens. The host closed and the temporary
project was removed. No real project or saved credential was modified.

The validation script now sets 13,000 input / 3,000 output / 16,000 total token limits, disables
unlimited budgets, retries and hosted web search, and restricts transport to the authorized
OpenAI generation endpoints. The coding journey is the access probe; there is no separate
unbudgeted model call. This live gate ran against the source composition under Bun; the
packaged Node and native-shell evidence remain separate. See the
[live-provider evidence](reports/TAURI_STAGE_7_LIVE_PROVIDER_2026-11-13.json).

See [the stage-7 report](reports/TAURI_STAGE_7_2026-11-13.json) for final evidence and remaining
gates. Until those gates pass, the rollout stays opt-in and Code remains available.
