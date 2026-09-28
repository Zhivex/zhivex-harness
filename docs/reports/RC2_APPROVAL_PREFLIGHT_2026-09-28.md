# RC2 approval input validation

## Confirmed release failure

Harness `v1.3.0-rc.1`, source `3abd087098ba1996e8335c7f8aab798b4ef6a369`,
[workflow attempt 1](https://github.com/Zhivex/zhivex-harness/actions/runs/36431227660),
passed exact artifact validation but failed base live certification. Meta passed;
Qwen failed at `request_arguments` with `AssertionError`, `approvalFields:
["proposalId"]`, and `retryable: false`. Later provider/certification gates and
npm publication did not complete. npm remained latest 1.2.0 / next 1.2.0-rc.13.

The retained artifact integrity was
`sha512-JncOSdo6Kf7wfhQhz0X28JGjU5hD1ztIZyhbycuoi3SQ6HdcHlSi+YksnbyONoGUT/QBaBq7aURKuMgt1nSciw==`.
The sanitized receipt is in the run's
`live-diagnostics-3abd087098ba1996e8335c7f8aab798b4ef6a369-1/base.json` artifact.

The receipt identifies the mismatching field but does not establish where its
value changed. Runtime/workspace/tool code and SDK dependency pins were unchanged
from stable 1.2.0; the engine extraction changed build splitting and entrypoints.
One bounded local Qwen diagnostic using the exact retained RC1 tarball returned a
correct proposal ID and a matching pending approval. It did not reproduce the
failure and was not a complete release certification. No raw provider payloads,
credentials or proposal IDs are included here. The historical cause remains
unproven; neither a provider regression nor a build regression is asserted.

## Reproducible guard gap and correction

Before RC2, `applyEditProposalInputSchema` checked shape and digest format, while
`validateEditProposal` checked the deterministic digest binding inside the tool's
execution, after operator approval. A correctly formatted but mismatched digest
could therefore create an unusable approval request.

The new deterministic test first emits a valid proposal, then an `apply_patch`
call with the wrong digest. It failed against the old code because that invalid
call became a pending approval. RC2 validates the binding in the input schema:

- Invalid-only input produces an error receipt, no pending approval, and no file.
- A corrected call still requires one valid operator approval.
- Approval/resume writes the expected fixture once; rejection never writes it.
- IDs are never rewritten or inferred for the model.

This preserves the exact base-live assertions, max-step limit and provider cohort.
The failure is not hidden by a retry or a weaker acceptance criterion. RC2 requires
its own exact-SHA CI, artifact, protected live/representative certification and npm
verification. Code 0.1.0-rc.1 is pinned to Harness 1.3.0-rc.2 and remains unpublished.

## RC2 local verification

- Complete engine test directory: 1,313 passed, 0 failed, 8,276 assertions.
- Code: 100 passed, 0 failed, 1,466 assertions.
- Root/tooling/Code types, public contract checks (baseline unchanged), architecture,
  release preflight and documentation passed.
- Exact local Harness RC2 and Code RC1 tarballs: installed npm/pnpm/Yarn/Bun
  consumers passed 4/4.
- One Qwen `qwen3.8-flash` base-live run on the installed RC2 tarball passed the
  original assertions: approval persisted, process restarted, one tool execution,
  one journal entry. This is bounded local evidence, not protected release or
  representative certification.

CI/CodeQL of the reviewed main commit, full protected certification, registry
publication and provenance remain pending. The first Code publication must use
its own GitHub-retained tarball/provenance after Harness RC2 is published.
