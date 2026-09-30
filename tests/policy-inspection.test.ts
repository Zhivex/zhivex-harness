import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness } from '../src/runtime/harness.js';
import { inspectHarnessPolicy } from '../src/runtime/policy-inspection.js';
import { createHarnessToolPolicy } from '../src/runtime/tool-policy.js';

test('policy inspection is a detached host snapshot and never evaluates or executes tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'policy-view-'));
  const policy = { schemaVersion: 1 as const, explicitReview: { schemaVersion: 1 as const }, rules: [{ id: 'read-review', tools: ['read_file'],
    decision: 'ask_user' as const, reason: 'Review /private/customer/data.txt with sk-fixturesecret123 before reading' }] };
  let decisions = 0;
  const harness = await createHarness({ workspace: root, subagentProfiles: [], modelInstance: createMockLanguageModel(), toolPolicy: policy,
    onToolPolicyDecision: () => { decisions++; } });
  try {
    const first = inspectHarnessPolicy(harness);
    expect(first).toMatchObject({ schemaVersion: 1, digest: createHarnessToolPolicy(policy).digest, source: 'application', explicitReviewRequired: true,
      execution: { configuredBackend: 'none', activeBackend: 'none', evidence: 'configuration-only' } });
    expect(first.tools.find(tool => tool.name === 'read_file')?.requiresApproval).toBe(true);
    expect(first.restrictions[0]?.reason).not.toContain('/private/customer');
    expect(JSON.stringify(first)).not.toContain('sk-fixturesecret123');
    expect(JSON.stringify(first)).not.toContain(root);
    first.tools.length = 0; first.restrictions.length = 0; first.limits.budget.maxToolCalls = 0;
    policy.rules.length = 0; harness.config.budget.maxToolCalls = 999;
    const second = inspectHarnessPolicy(harness);
    expect(second.tools.length).toBeGreaterThan(0); expect(second.restrictions).toHaveLength(1);
    expect(second.limits.budget.maxToolCalls).not.toBe(0); expect(second.limits.budget.maxToolCalls).not.toBe(999);
    expect(decisions).toBe(0); expect(harness.workspace.mutationAudit()).toHaveLength(0);
    expect(() => inspectHarnessPolicy({ ...harness })).toThrow('HOST_UNAVAILABLE');
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test('no policy is represented as baseline without claiming execution evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'policy-baseline-'));
  const harness = await createHarness({ workspace: root, subagentProfiles: [], modelInstance: createMockLanguageModel() });
  try {
    expect(inspectHarnessPolicy(harness)).toMatchObject({ schemaVersion: 1, digest: null, source: 'baseline', restrictions: [],
      explicitReviewRequired: false, execution: { activeBackend: 'none', evidence: 'configuration-only' } });
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
