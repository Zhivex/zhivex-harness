# Optional Web limits

New interactive Web/terminal tasks have no accumulated spend, token, step,
tool-call or duration cap unless configured. This change requires the unpublished
SDK contract from Zhivex/zhivex-ai-sdk PR 142 (Core/SDK 1.31.0, Agents 1.11.0).
This draft's offline fixture validation does not establish published dependency
readiness. Published pins remain unchanged until those artifacts are available.

The Web header opens the approved gradual configuration modal. Next task settings
override project settings once, including an empty override. Project settings
persist for future tasks in that workspace and tenant/user/namespace scope.
Settings are snapshotted on admission; changing them never rewrites an active run,
its recorded consumption, its approvals or its engine budget. A failed/rejected
submission is never automatically retried.

Tokens use reported SDK usage; steps count completed model iterations; tools count
unique tool-result receipts. Active duration excludes time parked for approval.
Unknown usage/pricing is shown as unavailable. Cost uses advisory model catalog
rates or explicit host rates; cached-input differences are conservatively estimated.
Unsupported pricing tiers and unaccounted auxiliary usage make the estimate
unavailable. The price source is visible on the run. No money is reserved and this
is not a guaranteed financial cap.

**Avisar** records a notice and lets the run continue. **Detener** requests the
existing active-run cancellation once, after observing the threshold. An in-flight
operation or final response can exceed it; completed work is not rolled back.
Consumption and durable effects remain recorded. Cancellation produces a cancelled
run, not a resumable pause; a subsequent user-submitted task carries the normal
bounded conversation context. There is no automatic replay. Observation/storage
failures remain visible; a known active stop policy requests cancellation, while
notification-only failures do not replace engine results with observer errors.

Thresholds are finite positive numbers; token/step/tool counts are integers.
Empty fields mean no user threshold. Cost/duration accept decimal comma or dot.
Steps and tools are separate controls. Exact revisions protect concurrent writes;
an uncertain save requires closing and reopening to inspect persisted settings.
The modal supports native dialog semantics, Escape, keyboard focus containment,
focus restoration, invalid-input messages and a scrollable mobile layout.

Preferences and per-run snapshots live in a private `web-limits` child directory
of the existing state directory, separate from SDK run JSON files. Files are
owner-private and regular with no symlink/hardlink traversal. Browser actions use
the same pairing, CSRF, Origin, loopback and workspace/session admission controls.
Permission policy, sandbox, state-size/model/context limits, operation timeouts,
tool-error/anti-loop controls and release gates remain independent.

## Host flags and legacy restart

`unlimitedTokens`, `unlimitedSteps`, `unlimitedToolCalls` and `unlimitedDuration`
are explicit opt-in engine flags. Numeric values remain stored and are inactive
only when their corresponding flag is true. Explicit numbers/environment values
prevent interactive default activation; explicit programmatic flags take precedence.
SDK/headless/certification defaults remain bounded. Child step/tool/deadline policy
is unchanged. `/limits <steps>` explicitly enables the requested finite console ceiling.

The SDK receives `Agent.maxSteps = "unlimited"`, omits step/tool budget fields and
gets a new policy without the accumulated `timeoutMs`. Finite model-request and
tool-execution timeouts still apply. JSON state/stream documents preserve the
literal `"unlimited"`; null, Infinity and large numeric sentinels are not used.
Flags survive runtime manifests and CLI resume metadata. Saved metadata without
flags restores bounded execution.

On Web startup, the original host acquires exclusive ownership before the complete
scoped run store is inspected through paged reads (the browser session list is
truncated and cannot prove completeness). Pending legacy, mixed, unknown, malformed
or mismatched policies keep the original host. Finish/cancel explicitly, then
restart Web to adopt new defaults. There is no automatic transition mid-session.
Pending tasks from this version may reopen only when their complete canonical
configuration matches the known candidate: CLI resume metadata or a session-bound
Web snapshot stores that recognition digest. No runtime is reconstructed from it;
SDK fingerprint, identity and admission checks remain authoritative and unchanged.

## Validation fixture

The versioned SDK bundle has Library ID
`libfile_bf9693683d9881918b80acaab54ba766`, source
`dfa34a68a13e3a3442f904b01f9e98925489b223`, SHA256
`30ca7ee2a8c7702b691162f8f93f169c187649b77978625708df7795262d85e5`.
The final SDK head `7c89f382bd88b47a7c5462797f74ad04f1f12e3f` artifact
11450387906 from CI 37545700729 has ZIP SHA256
`db641b05c83d4765eed1215fc6983ed4ff2e4fcfac37f8ec3d0911be933c6b3b`.
Its Core/Agents/SDK `dist` files were compared byte for byte against that bundle.
Installed consumer scripts accept `ZHIVEX_SDK_FIXTURE` only for explicit local
fixtures, verify package SHA256/SHA512 and record provenance without changing
repository pins or installing scripts. No provider requests are authorized by it.
