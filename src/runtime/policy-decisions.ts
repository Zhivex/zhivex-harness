import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { ToolSet } from '@zhivex-ai/core';
import { inspectHarnessPolicy, sanitizePolicyText } from './policy-inspection.js';
import type { HarnessToolPolicyDecision } from './tool-policy.js';

export const harnessPolicyDecisionEventSchema = z.strictObject({
  schemaVersion: z.literal(1), type: z.literal('policy-decision'),
  phase: z.enum(['approval-request', 'tool-entry']).default('tool-entry'),
  toolName: z.string().max(512), decision: z.enum(['allow', 'ask_user', 'deny']),
  ruleIds: z.array(z.string().max(512)).max(128), reason: z.string().max(4096), reasonTruncated: z.boolean(),
  policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  source: z.enum(['operator-file', 'application', 'baseline']), approvalRequired: z.boolean(), explicitReviewRequired: z.boolean(),
  executionBackend: z.enum(['none', 'oci']), evidence: z.literal('policy-evaluation')
});
export type HarnessPolicyDecisionEvent = z.infer<typeof harnessPolicyDecisionEventSchema>;
const observers = new AsyncLocalStorage<(event: HarnessPolicyDecisionEvent) => void | Promise<void>>();
/** Internal host observation scope. It grants no execution authority. */
export const observeHarnessPolicyDecisions = <T>(observer: (event: HarnessPolicyDecisionEvent) => void | Promise<void>, work: () => Promise<T>): Promise<T> => observers.run(observer, work);
export async function publishHarnessPolicyDecision(host: object, toolName: string, decision: HarnessToolPolicyDecision, phase: 'approval-request' | 'tool-entry' = 'tool-entry'): Promise<void> {
  const observer = observers.getStore();
  if (!observer) return;
  const view = inspectHarnessPolicy(host);
  const reason = sanitizePolicyText(decision.reason);
  const event = harnessPolicyDecisionEventSchema.parse({
    schemaVersion: 1, type: 'policy-decision', phase, toolName: sanitizePolicyText(toolName).slice(0, 512),
    decision: decision.decision, ruleIds: decision.ruleIds.map(id => sanitizePolicyText(id).slice(0, 512)),
    reason: reason.slice(0, 4096), reasonTruncated: reason.length > 4096, policyDigest: view.digest, source: view.source,
    approvalRequired: decision.decision === 'ask_user', explicitReviewRequired: decision.decision === 'ask_user' && view.explicitReviewRequired,
    executionBackend: view.execution.activeBackend, evidence: 'policy-evaluation'
  });
  await observer(event);
}

/** Keeps baseline approval and executor definitions unchanged; observation grants nothing. */
export function observeBaselineToolPolicy(tools: ToolSet, host: () => object | undefined): ToolSet {
  const result: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = 'execute' in definition ? definition.execute : undefined;
    result[name] = { ...definition, ...(execute ? { execute: async (input, context) => {
      const owner = host();
      if (owner) await publishHarnessPolicyDecision(owner, name, {
        decision: definition.requiresApproval === true ? 'ask_user' : 'allow', ruleIds: [],
        reason: definition.requiresApproval === true ? 'Existing tool approval is required; entering the executor after approval.' : 'No additional application restriction; tool permission checks still apply.'
      });
      return execute(input, context);
    } } : {}) };
  }
  return result;
}

export async function publishPendingPolicyDecision(host: object, toolName: string, promoted: boolean): Promise<void> {
  if (!observers.getStore()) return;
  const view = inspectHarnessPolicy(host);
  const rules = view.restrictions.filter(rule => rule.tools.includes(toolName) && rule.decision === 'ask_user');
  await publishHarnessPolicyDecision(host, toolName, {
    decision: 'ask_user', ruleIds: rules.map(rule => rule.ruleId),
    reason: promoted ? 'Approval promoted from a child run; review is pending and no execution is certified.'
      : rules.length ? rules.map(rule => rule.reason).join('; ') + (rules.some(rule => rule.pathCount > 0) ? '; Path-scoped ask rules conservatively require review for this tool.' : '')
      : 'Existing tool approval is required; review is pending and no execution is certified.'
  }, 'approval-request');
}

export function createPolicyDecisionEvidence() {
  const events: HarnessPolicyDecisionEvent[] = [];
  let observed = 0;
  let bytes = 0;
  return {
    append(event: HarnessPolicyDecisionEvent) {
      observed++;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length < 64 && bytes + size <= 256 * 1024) { events.push(structuredClone(event)); bytes += size; }
    },
    snapshot() { return { schemaVersion: 1 as const, scope: 'invocation' as const, observed, truncated: observed > events.length, events: structuredClone(events) }; }
  };
}
export type PolicyDecisionEvidence = ReturnType<ReturnType<typeof createPolicyDecisionEvidence>['snapshot']>;
