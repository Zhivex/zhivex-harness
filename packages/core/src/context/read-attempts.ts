import type { AgentStep } from '@zhivex-ai/core';
import { createRedactionPolicy } from '@zhivex-ai/agents';

/** Durable, bounded audit of attempted reads, including denied/invalid calls.
 * Paths come from original call arguments, never from a successful output.
 * No result contents, arbitrary error messages or credentials enter diagnostics.
 */
export function collectReadAttempts(steps: readonly AgentStep[]) {
  const redact = createRedactionPolicy({ includeEmails: true });
  const calls = steps.flatMap(step => (step.response?.messages ?? []).flatMap(message => message.parts)
    .flatMap(part => part.type === 'tool-call' && ['read_file', 'read_files'].includes(part.toolCall.name)
      ? [{ step: step.index, call: part.toolCall }] : []));
  const results = new Map(steps.flatMap(step => step.toolResults).map(result => [result.toolCallId, result]));
  const seen = new Set<string>();
  const attempts = calls.filter(({ call }) => !seen.has(call.id) && !!seen.add(call.id)).map(({ step, call }) => {
    const input = call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {};
    const raw = call.name === 'read_file' ? [input.path] : Array.isArray(input.files)
      ? input.files.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item.path : undefined) : [];
    const paths = raw.slice(0, 20).filter((p): p is string => typeof p === 'string')
      .map(p => redact.redactText(p).slice(0, 512));
    const result = results.get(call.id);
    return { step, toolCallId: call.id, toolName: call.name, attemptedPaths: paths,
      argumentsRecorded: raw.length > 0 && raw.every(p => typeof p === 'string'),
      pathsTruncated: raw.length > 20 || raw.some(p => typeof p === 'string' && p.length > 512),
      outcome: !result ? 'unresolved' as const : result.isError ? 'failed' as const : 'succeeded' as const,
      ...(result?.error?.code ? { errorCode: result.error.code } : {}) };
  });
  const orphanResultIds = [...results.values()].filter(result => ['read_file','read_files'].includes(result.toolName) && !seen.has(result.toolCallId)).map(result => result.toolCallId);
  return { attempts: attempts.slice(-256), totalAttempts: attempts.length, omittedAttempts: Math.max(0, attempts.length - 256),
    orphanResultIds: orphanResultIds.slice(-256), totalOrphanResults: orphanResultIds.length };
}
