import type { LanguageModelMiddleware, TokenUsage } from '@zhivex-ai/core';
import { estimateContextTokens, measureContext } from './context-metrics.js';

/** Numeric diagnostics only. Estimates, actual usage and cache are deliberately separate. */
export function createRequestMeasurements() {
  const requests: Array<{ context: ReturnType<typeof measureContext>; estimatedInputTokens: number | null;
    inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
    completed: boolean }> = [];
  let omitted = 0;
  const start = (input: Parameters<typeof measureContext>[0]) => {
    const context = measureContext(input);
    const row = { context, estimatedInputTokens: context.unmeasuredToolDefinitions ? null : estimateContextTokens(context),
      inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null, completed: false };
    if (requests.length < 128) requests.push(row); else omitted++;
    return (usage: TokenUsage | undefined) => {
      const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
      row.inputTokens = count(usage?.inputTokens); row.outputTokens = count(usage?.outputTokens);
      row.cachedInputTokens = count(usage?.cachedInputTokens); row.completed = true;
    };
  };
  const middleware: LanguageModelMiddleware = { name: 'harness-request-measurements-v1',
    async wrapGenerate(context, next) { const finish = start(context.input); const result = await next(); finish(result.usage); return result; },
    async wrapStream(context, next) {
      const finish = start(context.input), stream = await next();
      return (async function* () { let finished = false;
        for await (const event of stream) { if (event.type === 'finish' && !finished) { finish(event.usage); finished = true; } yield event; }
      })();
    } };
  return { middleware, snapshot: () => ({ requests: structuredClone(requests), omitted }) };
}
