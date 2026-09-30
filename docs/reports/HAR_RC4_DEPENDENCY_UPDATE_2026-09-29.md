# RC4 dependency update — 29 September 2026

This follow-up validates the dependency update for PR #148. It does not overwrite
the earlier RC4 candidate or its certification. New Harness tarball SHA256:
`b4e26702df06d373a60bb2b679ef652004a86c7cca4f0f2715db72004fd845ee`.
The companion JSON preserves the new live outcomes and the separate comparison.

## Accepted and excluded updates

Updated Agents 1.10.2, Core 1.28.0, Anthropic 0.13.1, Gemini 0.13.0,
OpenAI 0.13.7, Qwen 0.16.3, Vertex 1.2.2, google-auth-library 11.1.0,
MCP server 2.2.0 and Node types 26.6.3. Desktop uses Lucide 1.48.0.
CodeQL uses the official v4.38.2 commit from Dependabot #143; Lucide matches #141.

The initially updated compiler API alias 7.0.2 failed architecture validation
because ScriptTarget/createSourceFile were unavailable. Keep that alias at
TypeScript 6.0.3; the TypeScript CLI stays at 7.0.2. The initial Core override
1.26.0 also broke the updated Agents import of core/ops. Core 1.28.0 now meets
the new ^1.27.0 ranges, with one shared contract identity. These initial failures
are not counted as successful validation.

## Verification

- Full `bun run check`: 1891 passed, 1 platform skip, 0 failures; all subsequent
  architecture, docs, contracts, types, migration, evaluation, benchmark and
  installed-package/MCP/OCI checks passed.
- Code: 100 tests passed; Code/Desktop/tooling types and SDK redaction passed.
- Dependency audit: no vulnerabilities in 131 packages. Frozen Bun install passed.
- New 322-file artifact passed inspection. Packaged macOS arm64 Desktop passed
  approvals, rejection, streaming, crash recovery and renderer isolation.
- Eight installed consumer cases passed on Node 22.21.0 with four managers and
  both installation orders. Two additional pnpm 11.25.0 cases passed with CI=true.

The original PR CI exposed two pre-existing fixture problems: pnpm automatically
froze a deliberately changing consumer lockfile, and the multi-process checkpoint
integration test used Bun's generic five-second deadline. The consumer fixture
now explicitly allows lockfile updates during its two installation steps; repository
frozen installs are unchanged. The checkpoint integration test has a 30-second
suite deadline and retains all assertions; both tests pass with CI=true.
These final fixture-only edits were checked separately after the full suite.

## Live outcomes and limits

The new artifact ran all six routes with Sonnet 5.5 for Anthropic. Delegation,
OCI and continuity passed on every route (36 continuity phases), and all four
cross-provider routes passed. Base passed 5/6: Meta returned provider HTTP 504.
Compaction passed 5/6: Qwen returned QWEN_RESPONSES_TOOL_CALL_INVALID. Meta passed
compaction and subsequent gates; no successful result replaces its original 504.

A separate predeclared diagnostic ran Qwen compaction twice on the previous
candidate and twice on the updated candidate. All four passed. The initial Qwen
failure was not reproduced; this is evidence against a deterministic regression,
not proof that provider failures cannot recur. The original live campaign remains
failed overall and must not be described as a complete green recertification.

No packages were published. Protected release configuration and certification,
and CI/CodeQL on the final PR commit, remain separate requirements.
