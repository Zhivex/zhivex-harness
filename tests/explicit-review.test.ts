import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentApprovalResponse, AgentRunState } from '@zhivex-ai/core';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { bindHostPolicyIdentity } from '../src/approvals/host-policy-identity.js';
import { consumeExplicitReviewResponses, issueExplicitReviewResponses, issueAutomaticApprovalResponses, issueObservedApprovalResponses } from '../src/approvals/explicit-review.js';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { terminalApprovalResolver } from '../src/cli/presentation.js';

const responses: AgentApprovalResponse[] = [{ provider: 'openai', approvalRequestId: 'a', approve: true }];
const snapshot = () => ({ runId: 'r', status: 'waiting_approval', revision: 4, scope: { tenantId: 'local' },
  pendingApprovals: [{ id: 'a', provider: 'openai', name: 'apply_patch', arguments: '{"value":1}' }] }) as AgentRunState;
const host = () => { const object = {}; bindHostPolicyIdentity(object, `sha256:${'a'.repeat(64)}`, true); return object; };

test('review receipt binds the full batch, state, policy, host and expiry and is consumed once', () => {
  const authority = host(); const state = snapshot();
  expect(() => consumeExplicitReviewResponses(authority, state, responses, 10)).toThrow('REQUIRED');
  const reviewed = issueExplicitReviewResponses(authority, state, responses, 'fixture-review', 10);
  expect(() => consumeExplicitReviewResponses(authority, state, [...reviewed], 11)).toThrow('REQUIRED');
  expect(consumeExplicitReviewResponses(authority, state, reviewed, 11).channel).toBe('fixture-review');
  expect(() => consumeExplicitReviewResponses(authority, state, reviewed, 12)).toThrow('REQUIRED');
  for (const changed of [{ ...state, revision: 5 }, { ...state, scope: { tenantId: 'other' } }, { ...state, pendingApprovals: [{ ...state.pendingApprovals[0]!, arguments: '{"value":2}' }] }]) {
    const receipt = issueExplicitReviewResponses(authority, state, responses, 'fixture-review', 10);
    expect(() => consumeExplicitReviewResponses(authority, changed, receipt, 11)).toThrow('STALE');
  }
  const expired = issueExplicitReviewResponses(authority, state, responses, 'fixture-review', 10);
  expect(() => consumeExplicitReviewResponses(authority, state, expired, 300010)).toThrow('EXPIRED');
  const foreign = issueExplicitReviewResponses(authority, state, responses, 'fixture-review', 10);
  expect(() => consumeExplicitReviewResponses(host(), state, foreign, 11)).toThrow('REQUIRED');
  expect(() => issueExplicitReviewResponses(authority, state, [], 'fixture-review')).toThrow('MISMATCH');
});

const fixture = async (body: (harness: Awaited<ReturnType<typeof createHarness>>, root: string) => Promise<void>, explicit = true) => {
  const root = await mkdtemp(path.join(tmpdir(), 'explicit-review-'));
  const harness = await createHarness({ workspace: root, subagentProfiles: [],
    toolPolicy: { schemaVersion: 1, ...(explicit ? { explicitReview: { schemaVersion: 1 as const } } : {}), rules: [] },
    modelInstance: createMockLanguageModel({ streamEvents: [[
      { type: 'tool-call', toolCall: { id: 'edit', name: 'apply_reviewed_edits', input: { changes: [{ path: 'approved.txt', expectedDigest: null, content: 'reviewed' }] } } },
      { type: 'finish', finishReason: 'tool-calls' }
    ], [{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] }) });
  try { await body(harness, root); } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
};

test('auto cannot satisfy explicit review and leaves the persisted operation pending', () => fixture(async (harness, root) => {
  await expect(runHarness(harness, { runId: 'auto-test', prompt: 'write file' }, {
    resolveApprovals: terminalApprovalResolver('auto', async () => { throw new Error('must not prompt'); }, undefined, harness)
  })).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  expect((await harness.store.load('auto-test', harness.config.scope))?.status).toBe('waiting_approval');
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
}));

test('resume requires host evidence; a reviewed exact batch applies once', () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const decisions = pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  await expect(runHarness(harness, { state: pending.state, approvals: decisions })).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
  const reviewed = issueExplicitReviewResponses(harness, pending.state, decisions, 'fixture-review');
  const save = harness.store.save.bind(harness.store); let witnessed = false;
  harness.store.save = async (state, options) => {
    if (!witnessed && state.metadata?.clientApprovalDecisionsV1) {
      expect(state.metadata.clientApprovalDecisionsV1).toMatchObject([{ provenance: { schemaVersion: 1, origin: 'interactive', channel: 'fixture-review' } }]);
      expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
      witnessed = true;
    }
    return save(state, options);
  };
  expect((await runHarness(harness, { state: pending.state, approvals: reviewed })).status).toBe('completed');
  expect(witnessed).toBe(true); harness.store.save = save;
  expect(await Bun.file(path.join(root, 'approved.txt')).text()).toBe('reviewed');
  await expect(runHarness(harness, { state: pending.state, approvals: reviewed })).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  expect(harness.workspace.mutationAudit()).toHaveLength(1);
}));

test('persisted revision changes invalidate review even when a caller supplies the old state', () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const decisions = pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  const reviewed = issueExplicitReviewResponses(harness, pending.state, decisions, 'fixture-review');
  await harness.store.save({ ...pending.state, metadata: { ...pending.state.metadata, changed: true } }, { expectedRevision: pending.state.revision! });
  await expect(runHarness(harness, { state: pending.state, approvals: reviewed })).rejects.toThrow('EXPLICIT_REVIEW_STALE');
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
}));

test('terminal explicit confirmation produces host evidence and durable interactive provenance', () => fixture(async (harness, root) => {
  let prompts = 0;
  const result = await runHarness(harness, { prompt: 'write file' }, {
    resolveApprovals: terminalApprovalResolver('ask', async () => { prompts++; return 'y'; }, undefined, harness)
  });
  expect(prompts).toBe(1); expect(result.status).toBe('completed');
  expect(result.state.metadata?.clientApprovalDecisionsV1).toMatchObject([{ provenance: { origin: 'interactive', channel: 'cli-terminal' } }]);
  expect(await Bun.file(path.join(root, 'approved.txt')).text()).toBe('reviewed');
}));

for (const resumed of [false, true]) test(`terminal explicit denial persists before continuation (resume=${resumed})`, () => fixture(async (harness, root) => {
  const resolve = terminalApprovalResolver('ask', async () => 'n', undefined, harness);
  const save = harness.store.save.bind(harness.store);
  let witnessed = false;
  harness.store.save = async (state, options) => {
    if (!witnessed && state.metadata?.clientApprovalDecisionsV1) {
      expect(state.status).toBe('waiting_approval');
      expect(state.metadata.clientApprovalDecisionsV1).toMatchObject([{ approved: false, provenance: { origin: 'interactive', channel: 'cli-terminal' } }]);
      expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
      witnessed = true;
    }
    return save(state, options);
  };
  let result;
  if (resumed) {
    const pending = await runHarness(harness, { prompt: 'write file' });
    const decisions = await resolve!(pending.state.pendingApprovals, pending.state);
    expect(decisions).toBeDefined();
    result = await runHarness(harness, { state: pending.state, approvals: decisions as AgentApprovalResponse[] });
  } else {
    result = await runHarness(harness, { prompt: 'write file' }, { resolveApprovals: resolve });
  }
  expect(witnessed).toBe(true);
  expect(result.state.metadata?.clientApprovalDecisionsV1).toHaveLength(1);
  expect(harness.workspace.mutationAudit()).toHaveLength(0);
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
}));

test('reviewed denial still validates the current durable revision', () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const reviewed = issueExplicitReviewResponses(harness, pending.state,
    pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: false })), 'cli-terminal');
  await harness.store.save({ ...pending.state, metadata: { ...pending.state.metadata, changed: true } }, { expectedRevision: pending.state.revision! });
  await expect(runHarness(harness, { state: pending.state, approvals: reviewed })).rejects.toThrow('EXPLICIT_REVIEW_STALE');
  const current = await harness.store.load(pending.state.runId, pending.state.scope);
  expect(current?.status).toBe('waiting_approval');
  expect(current?.metadata?.clientApprovalDecisionsV1).toBeUndefined();
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
}));

for (const mode of ['auto', 'restricted'] as const) test(`CLI ${mode} records automatic provenance before continuing without explicit policy`, () => fixture(async (harness, root) => {
  const save = harness.store.save.bind(harness.store); let witnessed = false;
  harness.store.save = async (state, options) => {
    if (!witnessed && state.metadata?.clientApprovalDecisionsV1) {
      expect(state.status).toBe('waiting_approval');
      expect(state.metadata.clientApprovalDecisionsV1).toMatchObject([{ approved: mode === 'auto', provenance: { origin: 'automatic', channel: 'cli-automatic' } }]);
      expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
      witnessed = true;
    }
    return save(state, options);
  };
  const result = await runHarness(harness, { prompt: 'write file' }, {
    resolveApprovals: terminalApprovalResolver(mode, async () => { throw new Error('must not prompt'); }, undefined, harness)
  });
  expect(witnessed).toBe(true);
  expect(result.state.metadata?.clientApprovalDecisionsV1).toHaveLength(1);
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(mode === 'auto');
}, false));

for (const lostAcknowledgement of [false, true]) test(`automatic admission fails closed on persistence error (lost ack=${lostAcknowledgement})`, () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const decisions = pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  const automatic = issueAutomaticApprovalResponses(harness, pending.state, decisions, 'cli-resume');
  const save = harness.store.save.bind(harness.store);
  harness.store.save = async (state, options) => {
    if (lostAcknowledgement) await save(state, options);
    throw new Error('fixture persistence failure');
  };
  await expect(runHarness(harness, { state: pending.state, approvals: automatic })).rejects.toThrow('fixture persistence failure');
  harness.store.save = save;
  await expect(runHarness(harness, { state: pending.state, approvals: automatic })).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
  const current = (await harness.store.load(pending.state.runId, pending.state.scope))!;
  if (lostAcknowledgement) {
    expect(current.metadata?.clientApprovalDecisionsV1).toMatchObject([{ provenance: { origin: 'automatic', channel: 'cli-resume' } }]);
    const retry = issueAutomaticApprovalResponses(harness, current, decisions, 'cli-resume');
    await expect(runHarness(harness, { state: current, approvals: retry })).rejects.toThrow('ALREADY_RECORDED');
  } else {
    expect(current.metadata?.clientApprovalDecisionsV1).toBeUndefined();
  }
  expect(harness.workspace.mutationAudit()).toHaveLength(0);
}, false));

test('ordinary terminal answers persist interactive origin without requiring explicit policy', () => fixture(async (harness, root) => {
  const result = await runHarness(harness, { prompt: 'write file' }, {
    resolveApprovals: terminalApprovalResolver('ask', async () => 'y', undefined, harness)
  });
  expect(result.state.metadata?.clientApprovalDecisionsV1).toMatchObject([{ approved: true, provenance: { origin: 'interactive', channel: 'cli-terminal' } }]);
  expect(await Bun.file(path.join(root, 'approved.txt')).text()).toBe('reviewed');
}, false));

test('observed interactive origin is not evidence of complete explicit review', () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const decisions = pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  const observed = issueObservedApprovalResponses(harness, pending.state, decisions, 'cli-terminal', decisions.map(() => 'interactive'));
  await expect(runHarness(harness, { state: pending.state, approvals: observed })).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
}));

test('application resolver persists its origin before effects without asserting human review', () => fixture(async (harness, root) => {
  const save = harness.store.save.bind(harness.store); let witnessed = false;
  harness.store.save = async (state, options) => {
    if (!witnessed && state.metadata?.clientApprovalDecisionsV1) {
      expect(state.status).toBe('waiting_approval');
      expect(state.metadata.clientApprovalDecisionsV1).toMatchObject([{ provenance: { origin: 'application', channel: 'application-resolver' } }]);
      expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
      witnessed = true;
    }
    return save(state, options);
  };
  const result = await runHarness(harness, { prompt: 'write file' }, {
    resolveApprovals: async approvals => approvals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }))
  });
  expect(witnessed).toBe(true);
  expect(result.state.metadata?.clientApprovalDecisionsV1).toHaveLength(1);
  expect(await Bun.file(path.join(root, 'approved.txt')).text()).toBe('reviewed');
}, false));

test('observed application batches may be partial while explicit review still requires the whole set', () => {
  const authority = host(); const state = snapshot();
  state.pendingApprovals.push({ ...state.pendingApprovals[0]!, id: 'b' });
  const denied = responses.map(response => ({ ...response, approve: false }));
  const observed = issueObservedApprovalResponses(authority, state, denied, 'application-resolver', ['application']);
  expect(consumeExplicitReviewResponses(authority, state, observed).origins).toEqual(['application']);
  expect(() => issueExplicitReviewResponses(authority, state, denied, 'cli-terminal')).toThrow('MISMATCH');
});

test('an application resolver cannot claim explicit review by returning a positive response', () => fixture(async (harness, root) => {
  await expect(runHarness(harness, { runId: 'application-blocked', prompt: 'write file' }, {
    resolveApprovals: async approvals => approvals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }))
  })).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  const current = await harness.store.load('application-blocked', harness.config.scope);
  expect(current?.status).toBe('waiting_approval');
  expect(current?.metadata?.clientApprovalDecisionsV1).toBeUndefined();
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
}));

test('direct API resume records application intent and rejects resubmitting a recorded decision', () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const decisions = pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  const save = harness.store.save.bind(harness.store); let witnessed = false;
  harness.store.save = async (state, options) => {
    if (!witnessed && state.metadata?.clientApprovalDecisionsV1) {
      expect(state.status).toBe('waiting_approval');
      expect(state.metadata.clientApprovalDecisionsV1).toMatchObject([{ provenance: { origin: 'application', channel: 'application-resume' } }]);
      expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
      witnessed = true;
      await save(state, options);
      throw new Error('fixture lost acknowledgement');
    }
    return save(state, options);
  };
  await expect(runHarness(harness, { state: pending.state, approvals: decisions })).rejects.toThrow('fixture lost acknowledgement');
  harness.store.save = save;
  const current = (await harness.store.load(pending.state.runId, pending.state.scope))!;
  await expect(runHarness(harness, { state: current, approvals: decisions })).rejects.toThrow('ALREADY_RECORDED');
  expect(witnessed).toBe(true);
  expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
  expect(current.metadata?.clientApprovalDecisionsV1).toHaveLength(1);
}, false));

test('incompatible API resume cannot record intent or prevent resuming under the original policy', () => fixture(async (harness, root) => {
  const pending = await runHarness(harness, { prompt: 'write file' });
  const decisions = pending.state.pendingApprovals.map(a => ({ provider: a.provider, approvalRequestId: a.id, approve: true }));
  const other = await createHarness({ workspace: root, store: harness.store, subagentProfiles: [], modelInstance: harness.agent.model,
    toolPolicy: { schemaVersion: 1, rules: [{ id: 'deny-read', tools: ['read_file'], decision: 'deny', reason: 'Different policy' }] } });
  try {
    await expect(runHarness(other, { state: pending.state, approvals: decisions })).rejects.toThrow('different harness fingerprint');
    const current = (await harness.store.load(pending.state.runId, pending.state.scope))!;
    expect(current.revision).toBe(pending.state.revision);
    expect(current.metadata?.clientApprovalDecisionsV1).toBeUndefined();
    expect(await Bun.file(path.join(root, 'approved.txt')).exists()).toBe(false);
    expect((await runHarness(harness, { state: current, approvals: decisions })).status).toBe('completed');
    expect(await Bun.file(path.join(root, 'approved.txt')).text()).toBe('reviewed');
  } finally { await other.close(); }
}, false));

test('observed provenance does not impose an explicit-review deadline when the policy is omitted', () => {
  const authority = {}; bindHostPolicyIdentity(authority, `sha256:${'b'.repeat(64)}`, false);
  const state = snapshot();
  const observed = issueObservedApprovalResponses(authority, state, responses, 'cli-terminal', ['interactive'], 10);
  expect(consumeExplicitReviewResponses(authority, state, observed, 3_600_010).origins).toEqual(['interactive']);
});
