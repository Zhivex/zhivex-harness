import { createPolicyDecisionEvidence, observeHarnessPolicyDecisions, type HarnessPolicyDecisionEvent, type PolicyDecisionEvidence } from '../runtime/policy-decisions.js';
import { sanitizeTerminalText } from './terminal/terminal-ui.js';

export const formatPolicyDecision = (event: HarnessPolicyDecisionEvent): string => sanitizeTerminalText(
  `Policy · ${event.toolName} · ${event.phase} · ${event.decision}${event.explicitReviewRequired ? ' · explicit review required' : ''} · ${event.ruleIds.join(', ') || 'baseline'}: ${event.reason}${event.reasonTruncated ? ' [reason truncated]' : ''}`
);
export async function observeCliPolicy<T>(options: { json?: boolean; jsonl?: boolean }, tracker: { sequence?: number; policyEvidence?: PolicyDecisionEvidence }, work: () => Promise<T>): Promise<T> {
  const evidence = createPolicyDecisionEvidence();
  try {
    return await observeHarnessPolicyDecisions(event => {
      evidence.append(event);
      if (options.jsonl) process.stdout.write(JSON.stringify({ ...event, kind: 'run-event', sequence: tracker.sequence = (tracker.sequence ?? 0) + 1 })+'\n');
      else if (!options.json) process.stderr.write(formatPolicyDecision(event)+'\n');
    }, work);
  } finally { tracker.policyEvidence = evidence.snapshot(); }
}
