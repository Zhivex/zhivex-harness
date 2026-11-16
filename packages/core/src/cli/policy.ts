import { inspectHarnessPolicy, type HarnessPolicyInspection } from '../runtime/policy-inspection.js';
import { createConfiguredHarness } from './configured-harness.js';
import type { CliOptions } from './arguments.js';
import { sanitizeTerminalText } from './terminal/terminal-ui.js';

export function formatPolicyInspection(policy: HarnessPolicyInspection): string {
  return [
    `Policy: ${policy.source} · ${policy.digest ?? 'baseline'}`,
    `Explicit review: ${policy.explicitReviewRequired ? 'required for approvals' : 'not configured'}`,
    `Execution backend: ${policy.execution.activeBackend} (configured: ${policy.execution.configuredBackend})`,
    'Evidence: configuration only; no tool execution is certified by this query.',
    `Limits: ${policy.limits.maxSteps} steps, ${policy.limits.timeoutMs} ms`,
    'Tools:', ...policy.tools.map(tool => `  ${tool.name}: ${tool.requiresApproval ? 'approval required' : 'no baseline approval'}`),
    'Additional restrictions:', ...policy.restrictions.map(rule => `  ${rule.ruleId}: ${rule.decision} · ${rule.tools.join(', ')} · ${rule.reason}${rule.pathCount ? ` (${rule.pathCount} scoped paths omitted)` : ''}`)
  ].map(sanitizeTerminalText).join('\n');
}
export function printPolicyInspection(policy: HarnessPolicyInspection, json: boolean | undefined): void {
  process.stdout.write((json ? JSON.stringify(policy, null, 2) : formatPolicyInspection(policy)) + '\n');
}
export async function inspectCliPolicy(options: CliOptions): Promise<void> {
  const { harness } = await createConfiguredHarness(options);
  try { printPolicyInspection(inspectHarnessPolicy(harness), options.json); }
  finally { await harness.close(); }
}
