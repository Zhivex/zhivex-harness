# Isolated MCP stdio for trusted hosts

`@zhivex-ai/harness/mcp/stdio/v1` is an **experimental**, Node/Bun host-only entry point. It requires a local Docker daemon and previously provisioned immutable images. It does not enable `stdio` in workspace MCP JSON or ACP configuration. Never construct host policy, authorization callbacks, secret resolvers or host identity from model output or repository instructions.

The host owns the flow:

1. Open the canonical workspace and SQLite persistence using the root `Workspace`, `resolveHarnessConfig` and `openHarnessPersistence` APIs. Choose a scoped run ID before launching.
2. Call `prepareMcpWorkspaceSnapshot(workspace, maxWorkspaceBytes)`. Review the snapshot digest, explicit tool allowlist, permissions, image digest, command, literal environment, secret references and limits in a `McpStdioLaunchProposal`. Host authority must constrain every resource limit.
3. Create `createMcpStdioAdmissionAuthority({ policyVersion, maximumLimits, authorize })`. Its authorization callback receives the reviewed proposal; require your explicit operator/policy decision. `admit(proposal)` returns a short-lived, one-use receipt bound to the exact proposal.
4. Call `launchIsolatedMcpSession` with authority, receipt, proposal, snapshot, authenticated scope, immutable provisioner image ID, host secret resolver and `journal: { store, runId, scope, hostId }`. It recovers prior dead-owner resources before launch and refuses unresolved live/foreign resources. `hostId` must be a stable identity owned by the host, not the repository.
5. Pass the returned `hostSession` as `isolatedMcpSession` to `createHarness`, with the same store, canonical workspace and scope. Call `runHarness` with the admitted run ID. Every MCP call requires interrupt approval, including tools claiming to be read-only. Closing the harness closes the isolated session.
6. To resume a persisted approval after closing the host, reopen SQLite, create and admit a new session with the same reviewed proposal/snapshot, recreate the harness, and resume the saved state. Proposal changes invalidate the old approval. Secret values are resolved afresh by the trusted host.

A host can use `recoverDockerMcpResources({ store, runId, scope, hostId })` on startup without starting a new server. Recovery only considers persisted names and matching scope/host/daemon/images/labels. It refuses live or inaccessible owner PIDs and confirms resource absence before recording closure. Docker administrative access remains a trusted boundary.

Timeout, cancellation or loss of an execution acknowledgement leaves an uncertain outcome and blocks further MCP calls in that run. After cleanup and external inspection, `createMcpReconciliationAuthority` lets the host authorize a decision bound to call ID, expected revision, confirmed effect/no-effect and evidence digest. The previous outcome remains in the audit record. The original call key never becomes replayable. A new call still needs a new session admission and tool approval. This API supplies policy hooks, not a human review interface.

The snapshot is private and size-bounded. It does not mount the host workspace; changes inside it do not automatically return to the host. No host fallback or outbound network is granted. JSON Schema regex/reference features outside the supported bounded subset fail discovery. The entry point deliberately omits raw launch clients, arbitrary Docker execution and host capability issuers.

See [the isolation decision](adr/0002-isolated-mcp-stdio.md) and [API stability](STABILITY.md). Local candidate verification is distinct from registry publication.
