import { createRedactionPolicy } from '@zhivex-ai/agents';
import type { ToolSet } from '@zhivex-ai/core';
import type { HarnessConfig } from './config.js';
import { createHarnessToolPolicy, type HarnessToolPolicy } from './tool-policy.js';

const redaction = createRedactionPolicy({ includeEmails: true });
export const sanitizePolicyText = (text: string) => redaction.redactText(text)
  .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi, '[REDACTED]')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
  .replace(/(?:[A-Za-z]:\\|\/)[^\s;,]+/g, '[PRIVATE_PATH]');

export interface HarnessPolicyInspection {
  schemaVersion: 1;
  kind: 'policy-inspection';
  digest: string | null;
  source: 'operator-file' | 'application' | 'baseline';
  explicitReviewRequired: boolean;
  tools: Array<{ name: string; requiresApproval: boolean }>;
  restrictions: Array<{ ruleId: string; tools: string[]; decision: 'allow' | 'ask_user' | 'deny'; reason: string; pathCount: number }>;
  execution: { configuredBackend: 'none' | 'oci'; activeBackend: 'none' | 'oci'; evidence: 'configuration-only' };
  limits: { maxSteps: number; timeoutMs: number; unlimitedDuration?: boolean; budget: HarnessConfig['budget']; oci?: {
    maxProcessRuntimeMs: number; maxProcessOutputBytes: number; maxMemoryMb: number;
    maxPids: number; maxCpus: number; maxWorkspaceBytes: number; maxFileWriteBytes: number; tmpfsMb: number;
  } };
}
const inspections = new WeakMap<object, HarnessPolicyInspection>();

/** Host registration only. Paths, credentials, input payloads and execution claims are excluded. */
export function bindHarnessPolicyInspection(host: object, input: {
  config: HarnessConfig; tools: ToolSet; policy?: HarnessToolPolicy; operatorFile: boolean; hasOciEnvironment: boolean;
}): void {
  if (inspections.has(host)) throw new Error('POLICY_INSPECTION_ALREADY_BOUND');
  const compiled = input.policy ? createHarnessToolPolicy(input.policy) : undefined;
  const execution = input.config.execution;
  const limits: HarnessPolicyInspection['limits'] = {
    maxSteps: input.config.maxSteps, timeoutMs: input.config.timeoutMs,
    ...(input.config.unlimitedDuration === undefined ? {} : { unlimitedDuration: input.config.unlimitedDuration }), budget: structuredClone(input.config.budget),
    ...(execution.backend === 'oci' ? { oci: {
      maxProcessRuntimeMs: execution.maxProcessRuntimeMs, maxProcessOutputBytes: execution.maxProcessOutputBytes,
      maxMemoryMb: execution.maxMemoryMb, maxPids: execution.maxPids, maxCpus: execution.maxCpus,
      maxWorkspaceBytes: execution.maxWorkspaceBytes, maxFileWriteBytes: execution.maxFileWriteBytes, tmpfsMb: execution.tmpfsMb
    } } : {})
  };
  inspections.set(host, {
    schemaVersion: 1, kind: 'policy-inspection', digest: compiled?.digest ?? null,
    source: compiled ? input.operatorFile ? 'operator-file' : 'application' : 'baseline',
    explicitReviewRequired: compiled?.policy.explicitReview?.schemaVersion === 1,
    tools: Object.entries(input.tools).sort(([a], [b]) => a.localeCompare(b)).map(([name, tool]) => ({ name: sanitizePolicyText(name), requiresApproval: tool.requiresApproval === true })),
    restrictions: (compiled?.policy.rules ?? []).map(rule => ({ ruleId: sanitizePolicyText(rule.id), tools: rule.tools.map(sanitizePolicyText),
      decision: rule.decision, reason: sanitizePolicyText(rule.reason), pathCount: rule.paths?.length ?? 0 })),
    execution: { configuredBackend: execution.backend, activeBackend: input.hasOciEnvironment ? 'oci' : 'none', evidence: 'configuration-only' }, limits
  });
}

/** Returns a detached view of the configuration captured by this host, never model/client input. */
export function inspectHarnessPolicy(host: object): HarnessPolicyInspection {
  const inspection = inspections.get(host);
  if (!inspection) throw new Error('POLICY_INSPECTION_HOST_UNAVAILABLE');
  return structuredClone(inspection);
}
