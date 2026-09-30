import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { observeHarnessPolicyDecisions, type HarnessPolicyDecisionEvent } from '../src/runtime/policy-decisions.js';

for (const scenario of ['baseline-read', 'baseline-pending', 'policy-pending'] as const) test(`decision observation: ${scenario}`, async () => {
  const root = await mkdtemp('/tmp/har-policy-decision-');
  await writeFile(root+'/read.txt', 'fixture');
  const mutation = scenario !== 'baseline-read';
  const tool = mutation ? { id: 'edit', name: 'apply_reviewed_edits', input: { changes: [{ path: 'output.txt', expectedDigest: null, content: 'not yet' }] } }
    : { id: 'read', name: 'read_file', input: { path: 'read.txt' } };
  const harness = await createHarness({ workspace: root, subagentProfiles: [],
    ...(scenario === 'policy-pending' ? { toolPolicy: { schemaVersion: 1 as const, explicitReview: { schemaVersion: 1 as const }, rules: [{ id: 'review-edits', tools: ['apply_reviewed_edits'], decision: 'ask_user' as const, reason: 'Review changes first' }] } } : {}),
    modelInstance: createMockLanguageModel({ streamEvents: [[{ type: 'tool-call', toolCall: tool }, { type: 'finish', finishReason: 'tool-calls' }],
      [{ type: 'text-delta', textDelta: 'done' }, { type: 'finish', finishReason: 'stop' }]] }) });
  try {
    const events: HarnessPolicyDecisionEvent[] = [];
    const result = await observeHarnessPolicyDecisions(async event => {
      expect(await Bun.file(root+'/output.txt').exists()).toBe(false);
      events.push(event);
    }, () => runHarness(harness, { prompt: 'fixture' }));
    const event = events.find(item => item.toolName === tool.name)!;
    expect(event).toBeDefined();
    expect(event).toMatchObject({ decision: mutation ? 'ask_user' : 'allow', phase: mutation ? 'approval-request' : 'tool-entry',
      approvalRequired: mutation, explicitReviewRequired: scenario === 'policy-pending', source: scenario === 'policy-pending' ? 'application' : 'baseline', evidence: 'policy-evaluation' });
    expect(event.ruleIds).toEqual(scenario === 'policy-pending' ? ['review-edits'] : []);
    expect(result.status).toBe(mutation ? 'waiting_approval' : 'completed');
    expect(harness.workspace.mutationAudit()).toHaveLength(0);
    if (mutation) expect(events.some(item => item.phase === 'tool-entry')).toBe(false);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test('bounded decision evidence reports truncation and returns detached snapshots', async () => {
  const { createPolicyDecisionEvidence } = await import('../src/runtime/policy-decisions.js');
  const evidence = createPolicyDecisionEvidence();
  const event: HarnessPolicyDecisionEvent = { schemaVersion: 1, type: 'policy-decision', phase: 'tool-entry', toolName: 'read_file', decision: 'allow',
    ruleIds: [], reason: 'Baseline', reasonTruncated: false, policyDigest: null, source: 'baseline', approvalRequired: false,
    explicitReviewRequired: false, executionBackend: 'none', evidence: 'policy-evaluation' };
  for (let i=0;i<70;i++) evidence.append(event);
  const snapshot = evidence.snapshot();
  expect(snapshot).toMatchObject({ scope: 'invocation', observed: 70, truncated: true });
  expect(snapshot.events).toHaveLength(64);
  snapshot.events[0]!.reason = 'changed';
  expect(evidence.snapshot().events[0]!.reason).toBe('Baseline');
});
