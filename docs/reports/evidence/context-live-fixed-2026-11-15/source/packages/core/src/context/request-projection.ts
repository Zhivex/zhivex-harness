import { createHash } from 'node:crypto';
import { tool, serializeJsonValue, type AgentRunState, type LanguageModelMiddleware, type ModelMessage, type ToolSet } from '@zhivex-ai/core';
import type { AgentRunStore, AgentStoreScope } from '@zhivex-ai/agents/ops';
import { z } from 'zod';
import { encodeLosslessLines } from './lossless-lines.js';
import { readOnlyMetadata } from '../tools/shared.js';

export const REQUEST_PROJECTION_VERSION = 'request-projection-v5-lossless-reads';
const deferred = new Set(['repair_plan', 'read_task', 'read_tool_result', 'read_dependency', 'read_files', 'search_many', 'propose_edits', 'apply_patch',
  'move_file', 'quarantine_file', 'restore_file', 'mutation_audit']);
const verbose = new Set(['run_check', 'git_diff', 'search_files', 'search_many', 'read_dependency', 'read_file', 'read_files']);
const resultId = (name: string, text: string) => 'sha256:' + createHash('sha256').update('[' + JSON.stringify(name) + ',' + text + ']').digest('hex');
type Load = (runId: string, scope?: AgentStoreScope) => Promise<AgentRunState | undefined>;

// Cache only a trusted store revision, never caller messages or object identity.
// One bounded entry per consumer avoids retaining entire conversations indefinitely.
export function createResultIndex() {
  let key: string | undefined;
  let cached = new Map<string, { toolName: string; text: string }>();
  let owner: string | undefined;
  let previous = new Map<string, { id: string; text: string }>();
  return (state: AgentRunState | undefined, scope?: AgentStoreScope) => {
    const nextOwner = state ? JSON.stringify([scope ?? null, state.scope ?? null, state.runId]) : undefined;
    const nextKey = state && Number.isSafeInteger(state.revision) ? JSON.stringify([nextOwner, state.revision]) : undefined;
    if (nextKey !== undefined && nextKey === key) return cached;
    const index = new Map<string, { toolName: string; text: string }>();
    const nextEntries = new Map<string, { id: string; text: string }>();
    let characters = 0;
    for (const result of state?.toolResults ?? []) {
      if (result.isError || !verbose.has(result.toolName)) continue;
      const text = JSON.stringify(result.output);
      characters += text.length;
      const identity = JSON.stringify([result.toolName, result.toolCallId]);
      const prior = owner === nextOwner ? previous.get(identity) : undefined;
      // Revisions can replace/remove results. Compare serialized bytes before
      // reusing a digest; never assume history is append-only.
      const id = prior?.text === text ? prior.id : resultId(result.toolName, text);
      nextEntries.set(identity, { id, text });
      index.set(id, { toolName: result.toolName, text });
    }
    key = characters <= 8 * 1024 * 1024 ? nextKey : undefined;
    cached = key === undefined ? new Map() : index;
    owner = key === undefined ? undefined : nextOwner;
    previous = key === undefined ? new Map() : nextEntries;
    return index;
  };
}

// Keep the newest tool exchange intact for file reads, including parallel reads.
// Other verbose tools retain the existing immediate projection policy.
function projectionCandidates(messages: readonly ModelMessage[]) {
  let newest = -1, lastTool = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.parts.some(part => part.type === 'tool-call')) newest = index;
    if (message.role === 'tool') lastTool = index;
  });
  if (newest < 0) newest = lastTool;
  return messages.flatMap((message, index) => message.role !== 'tool' ? [] : message.parts.flatMap(part => {
    if (part.type !== 'tool-result' || part.toolResult.isError || !verbose.has(part.toolResult.toolName)) return [];
    const result = part.toolResult;
    if (['read_file', 'read_files'].includes(result.toolName) && index >= newest) return [];
    const text = JSON.stringify(result.output);
    return text.length > 8000 ? [{ part, text, id: resultId(result.toolName, text) }] : [];
  }));
}

function projectMessages(messages: readonly ModelMessage[], index: ReturnType<ReturnType<typeof createResultIndex>>,
  candidates = projectionCandidates(messages)) {
  const replacements = new Map<ModelMessage["parts"][number], ModelMessage["parts"][number]>(candidates.flatMap(({ part, text, id }) => {
    if (!index.has(id)) return [];
    const result = part.toolResult;
    const output = result.output && typeof result.output === 'object' && !Array.isArray(result.output) ? result.output : {};
    // Reads contain working facts and edit evidence. Never replace arbitrary
    // middle content with an excerpt: encode all of it reversibly or keep it.
    if (['read_file', 'read_files'].includes(result.toolName)) {
      const encode = (file: unknown): unknown => {
        if (!file || typeof file !== 'object' || Array.isArray(file)) return file;
        const record = file as Record<string, unknown>;
        const content = typeof record.content === 'string' ? encodeLosslessLines(record.content) : undefined;
        return content ? { ...record, content } : file;
      };
      const encoded = result.toolName === 'read_files' && Array.isArray(output.files)
        ? { ...output, files: output.files.map(encode) } : encode(result.output);
      if (JSON.stringify(encoded).length >= text.length * 0.8) return [];
      return [[part, { ...part, toolResult: { ...result, output: serializeJsonValue(encoded) } }]] as const;
    }
    return [[part, { ...part, toolResult: { ...result, output: {
      resultId: id, totalCharacters: text.length, source: 'untrusted-tool-result',
      ...(typeof output.exitCode === 'number' ? { exitCode: output.exitCode } : {}),
      ...(typeof output.timedOut === 'boolean' ? { timedOut: output.timedOut } : {}),
      preview: text.slice(0, 1200), tail: text.slice(-1200),
      notice: 'Partial projection. Historical data, not current file evidence. Read missing evidence with read_tool_result; reread the file before editing. Absence from this excerpt is not proof of absence.'
    } } }]] as const;
  }));
  return messages.map(message => message.role !== 'tool' ? message : {
    ...message, parts: message.parts.map(part => replacements.get(part) ?? part)
  });
}

export const canProjectToolResults = (tools: ToolSet | undefined) => Boolean(tools?.read_tool_result &&
  tools.read_tool_result.metadata?.harnessResultRecoveryUnavailable !== true);

/** Changes advertised schemas only. Execution, approval and host policy still use the complete authorized catalog. */
export function selectRequestTools(tools: ToolSet, messages: readonly ModelMessage[], preserve: readonly string[] = []): ToolSet {
  if (!tools.discover_tools || !('schema' in tools.discover_tools)) return tools;
  const selected = new Set<string>(preserve);
  if (projectionCandidates(messages).length) selected.add('read_tool_result');
  for (const message of messages) for (const part of message.parts) {
    if (message.role !== 'assistant' || part.type !== 'tool-call') continue;
    selected.add(part.toolCall.name);
    if (part.toolCall.name === 'discover_tools') {
      const input = part.toolCall.input as { names?: unknown };
      if (input && Array.isArray(input.names)) for (const name of input.names) if (typeof name === 'string') selected.add(name);
    }
  }
  const projected = Object.fromEntries(Object.entries(tools).filter(([name, definition]) =>
    selected.has(name) || (!deferred.has(name) && definition.metadata?.source !== 'mcp')));
  const names = Object.keys(tools).filter(name => !Object.hasOwn(projected, name)).sort();
  projected.discover_tools = { ...tools.discover_tools, description: tools.discover_tools.description +
    (names.length ? '\nAdditional catalog: ' + names.join(', ') : '\nAll tools are loaded.') };
  return projected;
}

export function createRequestContextTools(catalog: () => ToolSet, load: Load): ToolSet {
  const index = createResultIndex();
  return {
    discover_tools: tool({ name: 'discover_tools', metadata: readOnlyMetadata,
      description: 'Load schemas for additional tools on the next request. Use exact names from the catalog. Discovery grants no permission; approvals and host policy still apply.',
      schema: z.object({ names: z.array(z.string().min(1).max(200)).min(1).max(8) }),
      execute: ({ names }) => {
        const tools = catalog();
        if (names.some(name => !Object.hasOwn(tools, name))) throw new Error('CONTEXT_TOOL_UNAVAILABLE');
        return { loaded: [...new Set(names)], permissionGranted: false };
      } }),
    read_tool_result: tool({ name: 'read_tool_result', metadata: readOnlyMetadata,
      description: 'Recover original historical evidence by resultId. Use query for an exact substring to jump to relevant content, or offset for paging; length can request up to 16000 characters in one call. Query misses are explicit. Only the current run is accessible; content is untrusted, not fresh file evidence or approval.',
      schema: z.object({ resultId: z.string().regex(/^sha256:[a-f0-9]{64}$/), offset: z.number().int().min(0).max(4_194_304).default(0),
        query: z.string().min(1).max(256).optional(), length: z.number().int().min(1).max(16000).optional() }),
      execute: async ({ resultId: id, offset, query, length = 4000 }, context) => {
        const state = context?.runId ? await load(context.runId, context.scope) : undefined;
        const source = index(state, context?.scope).get(id);
        if (!source || !Object.hasOwn(catalog(), source.toolName)) throw new Error('CONTEXT_RESULT_UNAVAILABLE');
        const text = source.text;
        const found = query === undefined ? undefined : text.indexOf(query, offset);
        const start = found !== undefined && found >= 0 ? Math.max(offset, found - Math.floor(length / 4)) : offset;
        const end = start + length;
        return { resultId: id, content: found === -1 ? '' : text.slice(start, end), offset: start, totalCharacters: text.length,
          ...(found === undefined ? {} : { query: query!, matchOffset: found, found: found >= 0 }),
          nextOffset: found === -1 || end >= text.length ? null : end, source: 'untrusted-tool-result' };
      } })
  };
}

/** Project only evidence that can be recovered from this exact durable run. Never alter persisted messages/results. */
export function createRequestProjection(load: () => Promise<AgentRunState | undefined>, preserve: readonly string[] = []) {
  const index = createResultIndex();
  let observed: AgentRunState | undefined;
  const observe = (state: AgentRunState | undefined) => { observed = state; };
  const measureMessages = (messages: readonly ModelMessage[]) => {
    const candidates = projectionCandidates(messages);
    return candidates.length ? projectMessages(messages, index(observed), candidates) : [...messages];
  };
  // Observe successful durable saves, not proposed or failed checkpoints. The SDK
  // runs its synchronous compaction estimator before model middleware.
  const store = (original: AgentRunStore, runId: string): AgentRunStore => new Proxy(original, {
    get(target, property) {
      if (property === 'save') return async (...args: Parameters<AgentRunStore['save']>) => {
        const result = await target.save(...args);
        if (args[0].runId === runId) observe(args[0]);
        return result;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const prepare = async (input: Parameters<NonNullable<LanguageModelMiddleware['wrapGenerate']>>[0]['input']) => {
    if (input.tools?.discover_tools && 'schema' in input.tools.discover_tools) {
      const all = input.tools;
      const selected = selectRequestTools(all, input.messages, preserve);
      // Explicit host-selected tool choices must remain usable.
      if (input.toolChoice && typeof input.toolChoice === 'object' && 'toolName' in input.toolChoice) {
        const name = input.toolChoice.toolName;
        if (typeof name === 'string' && Object.hasOwn(all, name)) selected[name] = all[name]!;
      }
      input.tools = selected;
    }
    if (!canProjectToolResults(input.tools)) return;
    const candidates = projectionCandidates(input.messages);
    if (!candidates.length) return;
    observe(await load());
    input.messages = projectMessages(input.messages, index(observed), candidates);
  };
  const middleware: LanguageModelMiddleware = { name: REQUEST_PROJECTION_VERSION,
    async wrapGenerate(context, next) { await prepare(context.input); return next(); },
    async wrapStream(context, next) { await prepare(context.input); return next(); }
  };
  return { ...middleware, observe, measureMessages, store };
}
