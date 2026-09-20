# HU32 — reviewed push desktop integration

In progress. Push selection, review, authorization and response reconciliation are
now exposed in the desktop. PR creation and its no-duplicate recovery remain open;
none of the three full HU32 acceptance criteria is closed by this increment.

The renderer lists configured compatible GitHub HTTPS remotes, requires choosing
one, and exposes destination and existing base refs explicitly. Review shows local
branch/SHA, remote head/base, commit messages and complete per-parent file diffs and
modes. Changing inputs invalidates that review. A separate button authorizes one
reviewed push; the renderer cannot supply commands, arbitrary transports or force
options. Main validates sender/project/payload, preserves task identity checks and
uses the same runtime-admission guard as local Git mutations.

Main caches host transports/managers by project, tracks accepted remote operations
through shutdown, and removes the private network object stores after draining
work. The UI persists only a pending operation ID for response-loss recovery. After
reload, explicit reconciliation consults the durable record without another push.
Newline-containing host-sensitive values are checked as raw strings before review
projection, rather than against JSON-escaped text. Credentials remain in Git/gh.

Verification includes a real Electron user journey with a host-only Git executable
shim. The shim routes only the fixture GitHub URL to a disposable local bare remote,
allows file transport solely inside that fixture, and counts every routed push.
The test creates and reviews a task commit, authorizes its push, loses the response,
reloads the renderer, reconciles the same operation, restarts the whole app and
checks one commit and one push with an exact matching remote SHA. The original and
sibling branches retain their original heads. No GitHub call or implementation
branch publication is performed by this fixture.

The production adapter remains GitHub HTTPS with host Git/gh authentication; SSH,
enterprise and custom proxy configurations are not supported here. Preview limits
and detected-secret protections remain those of the push manager. This does not
claim universal secret detection, live authentication, signing or notarization.

Final verification: 687 tests passed, zero failures, 3930 assertions across 93
files. Root/desktop typechecks, docs and stable contract checks pass. The six
remote-manager/transport tests have 51 assertions, including raw multiline secret
rejection. The unsigned macOS arm64 package passed the expanded worktree journey
and the general desktop regression sequentially. The worktree driver confirms one
push, the exact remote SHA and deletion of every recorded private network store
on normal shutdown. The general smoke also verifies the expanded 22-method preload
allowlist, project isolation, review, renderer/runtime recovery and cancellation.

Evidence: `HAR_HU_32_PUSH_UI_PACKAGED_2026-09-20.json` and
`HAR_HU_32_PUSH_REGRESSION_2026-09-20.json`; the application-code ASAR SHA-256 is in
`HAR_HU_32_PUSH_CANDIDATE_2026-09-20.json`. It is not a signature or a hash of the
whole Electron distribution. No implementation-branch push or publication occurred.
