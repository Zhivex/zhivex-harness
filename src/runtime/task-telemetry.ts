import type { AgentStreamEvent } from '@zhivex-ai/agents';
import type { AgentRunStore } from '@zhivex-ai/agents/ops';
import type { LanguageModelMiddleware, ToolSet } from '@zhivex-ai/core';

export type TaskTelemetryKind = 'prepare' | 'context' | 'model' | 'compaction' | 'tool' | 'persistence' | 'render';
export type TaskTelemetryMilestone = 'prepare-start' | 'prepare-end' | 'first-event' | 'first-model-event'
  | 'first-text-event' | 'first-visible-text' | 'cancel-requested' | 'cancel-settled' | 'render-start' | 'render-end';
export type TaskTelemetryOutcome = 'completed' | 'error' | 'incomplete';
export interface TaskTelemetrySpan {
  kind: TaskTelemetryKind;
  startMs: number;
  durationMs: number;
  outcome: TaskTelemetryOutcome;
}
export type TaskTelemetryEvent = { type: 'milestone'; milestone: TaskTelemetryMilestone; elapsedMs: number }
  | { type: 'span'; span: TaskTelemetrySpan };
export interface TaskTelemetrySnapshot {
  schemaVersion: 1;
  scope: 'invocation';
  clock: 'monotonic';
  temperature: 'cold' | 'warm' | 'unknown';
  wallMs: number;
  finished: boolean;
  milestones: Partial<Record<TaskTelemetryMilestone, number>>;
  spans: TaskTelemetrySpan[];
  omittedSpans: number;
  activeSpans: number;
  observerErrors: number;
  clockErrors: number;
  /** Operation time can overlap; these totals must never be added to infer wall time. */
  operationTotals: Record<TaskTelemetryKind, { count: number; durationMs: number; errors: number; incomplete: number }>;
}

const storeMethods = new Set(['checkpointBytes', 'loadHistory', 'load', 'findByIdempotencyKey', 'findByParentRunId',
  'claimIdempotencyKey', 'save', 'delete', 'list', 'deleteExpired', 'acquireLease', 'renewLease', 'releaseLease',
  'loadToolCall', 'loadToolExecution', 'listToolCalls', 'saveToolCall', 'claimToolExecution', 'completeToolExecution']);

/** Numeric, bounded diagnostics. It records no prompts, output, tool arguments, errors, or identifiers.
 * Model middleware measures transport consumption, including failed and abandoned streams.
 * first-text-event is delivery to a host; only the renderer may mark first-visible-text.
 * This observer is supplemental and never replaces mandatory audit or checkpoint writes.
 */
export function createTaskTelemetry(options: {
  temperature?: TaskTelemetrySnapshot['temperature'];
  maxSpans?: number;
  now?: () => number;
  observer?: (event: TaskTelemetryEvent) => void | Promise<void>;
} = {}) {
  const maxSpans = options.maxSpans ?? 128;
  if (!Number.isSafeInteger(maxSpans) || maxSpans < 0 || maxSpans > 4096) throw new Error('Invalid telemetry span limit.');
  const now = options.now ?? (() => performance.now());
  let previous = 0, origin: number | undefined, clockErrors = 0, observerErrors = 0;
  const elapsed = () => {
    try {
      const current = now();
      if (!Number.isFinite(current)) { clockErrors++; return previous; }
      origin ??= current;
      previous = Math.max(previous, current - origin);
    } catch { clockErrors++; }
    return previous;
  };
  elapsed();
  const spans: TaskTelemetrySpan[] = [];
  const milestones: TaskTelemetrySnapshot['milestones'] = {};
  const operationTotals: TaskTelemetrySnapshot['operationTotals'] = {
    prepare: { count: 0, durationMs: 0, errors: 0, incomplete: 0 },
    context: { count: 0, durationMs: 0, errors: 0, incomplete: 0 },
    model: { count: 0, durationMs: 0, errors: 0, incomplete: 0 },
    compaction: { count: 0, durationMs: 0, errors: 0, incomplete: 0 },
    tool: { count: 0, durationMs: 0, errors: 0, incomplete: 0 },
    persistence: { count: 0, durationMs: 0, errors: 0, incomplete: 0 },
    render: { count: 0, durationMs: 0, errors: 0, incomplete: 0 }
  };
  let omittedSpans = 0, activeSpans = 0, finishedAt: number | undefined;
  const notify = (event: TaskTelemetryEvent) => {
    if (!options.observer) return;
    try {
      // Never await a diagnostic observer: a failed or stalled observer cannot change the run.
      const result = options.observer(structuredClone(event));
      if (result) void Promise.resolve(result).catch(() => { observerErrors++; });
    } catch { observerErrors++; }
  };
  const mark = (milestone: TaskTelemetryMilestone) => {
    if (milestones[milestone] !== undefined || finishedAt !== undefined) return;
    const elapsedMs = elapsed();
    milestones[milestone] = elapsedMs;
    notify({ type: 'milestone', milestone, elapsedMs });
  };
  const begin = (kind: TaskTelemetryKind) => {
    if (finishedAt !== undefined) return (_outcome?: TaskTelemetryOutcome) => {};
    const startMs = elapsed();
    activeSpans++;
    let settled = false;
    return (outcome: TaskTelemetryOutcome = 'completed') => {
      if (settled) return;
      settled = true; activeSpans--;
      const span = { kind, startMs, durationMs: elapsed() - startMs, outcome };
      const total = operationTotals[kind];
      total.count++; total.durationMs += span.durationMs;
      if (outcome === 'error') total.errors++;
      if (outcome === 'incomplete') total.incomplete++;
      if (spans.length < maxSpans) spans.push(span); else omittedSpans++;
      notify({ type: 'span', span });
    };
  };
  /** Preserve synchronous store behavior as well as async resolution and the original error. */
  const measure = <T>(kind: TaskTelemetryKind, work: () => T): T => {
    const end = begin(kind);
    try {
      const result = work();
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(result).then(value => { end(); return value; }, error => {
          end('error'); throw error;
        }) as T;
      }
      end(); return result;
    } catch (error) { end('error'); throw error; }
  };
  const modelMiddleware = (kind: 'model' | 'compaction' = 'model'): LanguageModelMiddleware => ({
    name: `harness-task-telemetry-${kind}-v1`,
    wrapGenerate(_context, next) { return measure(kind, next); },
    async wrapStream(_context, next) {
      const end = begin(kind);
      try {
        const stream = await next();
        return (async function* () {
          let outcome: TaskTelemetryOutcome = 'incomplete';
          try {
            for await (const event of stream) {
              if (kind === 'model') mark('first-model-event');
              if (event.type === 'finish' && outcome !== 'error') outcome = 'completed';
              if (event.type === 'error') outcome = 'error';
              yield event;
            }
          } catch (error) { outcome = 'error'; throw error; }
          finally { end(outcome); }
        })();
      } catch (error) { end('error'); throw error; }
    }
  });
  return {
    middleware: modelMiddleware(), modelMiddleware, mark, begin, measure,
    observeEvent(event: AgentStreamEvent) {
      mark('first-event');
      if (event.type === 'text-delta' && event.textDelta.length > 0) mark('first-text-event');
      if (event.type === 'agent-run-finish' && event.status === 'cancelled') mark('cancel-settled');
    },
    store(store: AgentRunStore): AgentRunStore {
      return new Proxy(store, { get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (typeof key === 'string' && storeMethods.has(key)) return (...args: unknown[]) =>
          measure('persistence', () => Reflect.apply(value, target, args));
        return value.bind(target);
      } });
    },
    tools(tools: ToolSet): ToolSet {
      return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
        const execute = 'execute' in definition ? definition.execute : undefined;
        return [name, execute ? { ...definition, execute: (input: unknown, context: Parameters<typeof execute>[1]) =>
          measure('tool', () => execute(input, context)) } : definition];
      }));
    },
    finish() { finishedAt ??= elapsed(); },
    snapshot(): TaskTelemetrySnapshot {
      return { schemaVersion: 1, scope: 'invocation', clock: 'monotonic', temperature: options.temperature ?? 'unknown',
        wallMs: finishedAt ?? elapsed(), finished: finishedAt !== undefined, milestones: { ...milestones },
        spans: spans.map(span => ({ ...span })), omittedSpans, activeSpans, observerErrors, clockErrors,
        operationTotals: structuredClone(operationTotals) };
    }
  };
}
