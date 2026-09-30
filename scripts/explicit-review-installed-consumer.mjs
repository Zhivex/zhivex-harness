// Installed package consumer: three real processes, persisted parent/child and host review.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHarness } from '@zhivex-ai/harness/engine';
import { createHarnessClientAdapter } from '@zhivex-ai/harness/client';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';

const phase = process.argv[2];
assert(['prepare', 'resume', 'verify'].includes(phase));
const changes = [{ path: 'child.txt', expectedDigest: null, content: 'reviewed child' }];
const finish = { type: 'finish', finishReason: 'stop' };
const parent = createMockLanguageModel({ provider: 'fixture-parent', modelId: 'parent', streamEvents: phase === 'prepare' ? [[
  { type: 'tool-call', toolCall: { id: 'delegate', name: 'delegate_implementer', input: { prompt: 'Write child.txt' } } },
  { type: 'finish', finishReason: 'tool-calls' }
]] : [[{ type: 'text-delta', textDelta: 'done' }, finish]] });
const child = createMockLanguageModel({ provider: 'fixture-child', modelId: 'child', responses: phase === 'prepare' ? [
  { messages: [{ role: 'assistant', parts: [{ type: 'tool-call', toolCall: { id: 'child-edit', name: 'apply_reviewed_edits', input: { changes } } }] }], finishReason: 'tool-calls' }
] : [{ messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'child done' }] }], text: 'child done', finishReason: 'stop' }] });
const policyFile = path.resolve('..', 'policy.json');
if (phase === 'prepare') await writeFile(policyFile, JSON.stringify({ schemaVersion: 1, explicitReview: { schemaVersion: 1 }, rules: [] }), { mode: 0o600 });
const harness = await createHarness({ workspace: process.cwd(), stateDirectory: path.resolve('..', 'state'), toolPolicyFile: policyFile,
  modelInstance: parent, subagentProfiles: ['implementer'], subagentModels: { implementer: child } });
const adapter = await createHarnessClientAdapter(harness);
const hello = adapter.negotiate([1]); assert(hello.ok);
let sequence = 0;
const request = command => ({ protocolVersion: 1, connectionId: hello.connectionId, requestId: `${phase}-${++sequence}`, command: { ...command, projectId: hello.projectId } });
const call = async command => { const result = await adapter.dispatch(request(command)); assert(result.ok, JSON.stringify(result)); return result.data; };
const file = path.join(process.cwd(), 'child.txt');
try {
  if (phase === 'prepare') {
    const { session } = await call({ method: 'session.create', idempotencyKey: 'session' });
    const waiting = await call({ method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'start', prompt: 'Delegate the edit' });
    assert.equal(waiting.run.status, 'waiting_approval');
    const state = await harness.store.load(waiting.run.runId, harness.config.scope);
    assert.equal(state.pendingApprovals[0].kind, 'subagent');
    const command = { method: 'approval.resolve', sessionId: session.sessionId, runId: state.runId, expectedRevision: state.revision, idempotencyKey: 'plain',
      decisions: waiting.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) };
    const rejected = await adapter.dispatch(request(command));
    assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'EXPLICIT_REVIEW_REQUIRED');
    assert.deepEqual(await harness.store.load(state.runId, harness.config.scope), state);
    await assert.rejects(readFile(file));
    await writeFile('identity.json', JSON.stringify({ sessionId: session.sessionId, runId: state.runId, childRunId: state.childRuns[0].runId }));
  } else {
    const identity = JSON.parse(await readFile('identity.json', 'utf8'));
    const before = await call({ method: 'run.get', sessionId: identity.sessionId, runId: identity.runId });
    if (phase === 'resume') {
      assert.equal(before.run.status, 'waiting_approval');
      await assert.rejects(readFile(file));
      const command = { method: 'approval.resolve', sessionId: identity.sessionId, runId: identity.runId, expectedRevision: before.run.revision, idempotencyKey: 'reviewed',
        decisions: before.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })) };
      // Trusted fixture host has inspected the complete durable parent/child payload.
      const result = await adapter.dispatchReviewed(request(command));
      assert(result.ok, JSON.stringify(result)); assert.equal(result.data.run.status, 'completed');
      const competitor = await createHarnessClientAdapter(harness);
      try {
        const second = competitor.negotiate([1]); assert(second.ok);
        const stale = await competitor.dispatchReviewed({ protocolVersion: 1, requestId: 'second-client', connectionId: second.connectionId,
          command: { ...command, projectId: second.projectId, idempotencyKey: 'second-client-review' } });
        assert.equal(stale.ok, false, 'Second client must not authorize an already consumed approval');
      } finally { competitor.close(); }
      const replay = await adapter.dispatchReviewed(request(command));
      assert(replay.ok); assert.equal(replay.data.run.status, 'completed');
      const ordinaryReplay = await adapter.dispatch(request(command));
      assert.equal(ordinaryReplay.ok, false); assert.equal(ordinaryReplay.error.code, 'IDEMPOTENCY_CONFLICT');
    } else assert.equal(before.run.status, 'completed');
    const final = await harness.store.load(identity.runId, harness.config.scope);
    assert.equal(final.metadata.clientApprovalDecisionsV1.length, 1);
    assert.equal(final.metadata.clientApprovalDecisionsV1[0].provenance.origin, 'interactive');
    assert.equal(final.metadata.clientApprovalDecisionsV1[0].provenance.channel, 'desktop-host');
    assert.equal(final.childRuns[0].runId, identity.childRunId);
    const journal = await harness.store.listToolCalls(identity.childRunId, harness.config.scope);
    assert.equal(journal.filter(row => row.toolName === 'apply_reviewed_edits' && row.status === 'completed').length, 1);
    assert.equal(await readFile(file, 'utf8'), 'reviewed child');
  }
} finally { adapter.close(); await harness.close(); }
console.log(JSON.stringify({ phase, ok: true, runtime: process.version, explicitReview: true, promotedChild: true }));
