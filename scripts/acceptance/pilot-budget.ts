import { measureContext } from '../../src/context/context-metrics.js';
import type { LanguageModelMiddleware, ModelGenerateInput, TokenUsage } from '@zhivex-ai/core';
import { z } from 'zod';
import type { CompetitivePilotPlan } from './pilot-protocol.js';

/** One meter per case, shared across approvals, reopen and new correction runs. */
export function createPilotBudget(limits: CompetitivePilotPlan['budget'], now = Date.now) {
  const started = now();
  const requests: Array<{ sequence: number; context: ReturnType<typeof measureContext>; estimatedInputTokens: number;
    inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
    admitted: boolean; completed: boolean }> = [];
  let active: typeof requests[number] | undefined;
  const stats = { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, usageComplete: true, inFlight: false, budgetExhausted: false };
  const fail = () => { stats.budgetExhausted = true; throw new Error('PILOT_BUDGET_EXHAUSTED'); };
  const check = () => {
    if (now() - started >= limits.timeoutMs || stats.steps > limits.maxSteps || stats.toolCalls > limits.maxToolCalls ||
      stats.inputTokens > limits.maxInputTokens || stats.outputTokens > limits.maxOutputTokens ||
      stats.inputTokens + stats.outputTokens > limits.maxTotalTokens) fail();
  };
  const before = (input: ModelGenerateInput) => {
    check();
    if (!stats.usageComplete || stats.inFlight) throw new Error('PILOT_USAGE_UNKNOWN');
    // Conservative admission estimate, not an exact provider tokenizer or invoice.
    const schemas = Object.entries(input.tools ?? {}).map(([name, tool]) => {
      if (!('schema' in tool)) throw new Error('PILOT_HOSTED_TOOL_UNSUPPORTED');
      return { name, description: tool.description, schema: z.toJSONSchema(tool.schema) };
    });
    const estimate = Math.ceil(Buffer.byteLength(JSON.stringify({ messages: input.messages, schemas })) / 2);
    const measurement = { sequence: requests.length + 1, context: measureContext(input), estimatedInputTokens: estimate,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, admitted: false, completed: false };
    requests.push(measurement);
    if (stats.steps >= limits.maxSteps || stats.inputTokens + estimate > limits.maxInputTokens) fail();
    const cap = Math.min(limits.maxOutputTokens - stats.outputTokens, limits.maxTotalTokens - stats.inputTokens - stats.outputTokens - estimate, input.maxTokens ?? Infinity);
    if (cap < 1) fail();
    input.maxTokens = cap;
    measurement.admitted = true; active = measurement;
    stats.steps++; stats.inFlight = true;
  };
  const usage = (value: TokenUsage | undefined) => {
    stats.inFlight = false;
    if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens) || value.inputTokens! < 0 || value.outputTokens! < 0) {
      stats.usageComplete = false; throw new Error('PILOT_USAGE_UNKNOWN');
    }
    if (active) { active.inputTokens = value.inputTokens!; active.outputTokens = value.outputTokens!;
      active.cachedInputTokens = Number.isSafeInteger(value.cachedInputTokens) && value.cachedInputTokens! >= 0 ? value.cachedInputTokens! : null;
      active.completed = true; active = undefined; }
    stats.inputTokens += value.inputTokens!; stats.outputTokens += value.outputTokens!;
    check();
  };
  const middleware: LanguageModelMiddleware = {
    name: 'pilot-case-budget-v1',
    async wrapGenerate(context, next) {
      before(context.input);
      try {
        const result = await next();
        stats.toolCalls += (result.messages ?? (result.message ? [result.message] : [])).flatMap(m => m.parts).filter(p => p.type === 'tool-call').length;
        usage(result.usage); return result;
      } finally { if (stats.inFlight) { stats.inFlight = false; stats.usageComplete = false; } }
    },
    async wrapStream(context, next) {
      before(context.input);
      try {
        const stream = await next();
        return (async function* () {
          let finished = false;
          try {
            for await (const event of stream) {
              if (event.type === 'tool-call') { stats.toolCalls++; check(); }
              if (event.type === 'finish') { if (finished) throw new Error('PILOT_DUPLICATE_USAGE'); finished = true; usage(event.usage); }
              yield event;
            }
          } finally { if (!finished) stats.usageComplete = false; stats.inFlight = false; }
        })();
      } catch (error) { stats.inFlight = false; stats.usageComplete = false; throw error; }
    }
  };
  return { stats, middleware, check, remainingMs: () => Math.max(0, limits.timeoutMs - (now() - started)),
    snapshot: () => ({ ...stats, durationMs: now() - started, requests: structuredClone(requests) }) };
}
