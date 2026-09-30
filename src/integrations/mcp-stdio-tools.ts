import { createRedactionPolicy, type JsonValue, type McpCallToolRequest, type McpCallToolOptions, type McpClient, type ToolSet } from '@zhivex-ai/core';
import { z } from 'zod';
import { createHarnessMcpTools, type HarnessMcpConfiguration } from './mcp.js';
import type { McpStdioLaunchProposal } from './mcp-stdio-admission.js';
import { createJournaledMcpClient } from '../persistence/mcp-execution-journal.js';
import { McpStdioClientError } from './mcp-stdio-client.js';

const record = z.record(z.string(), z.unknown());
const listing = z.object({
  tools: z.array(z.object({ name: z.string().min(1).max(128), description: z.string().max(16000).optional(),
    title: z.string().max(300).optional(), inputSchema: record.refine(value => value.type === 'object'),
    outputSchema: record.refine(value => value.type === 'object').optional(), annotations: record.optional()
  }).passthrough()).max(200),
  nextCursor: z.string().min(1).max(2048).optional(), _meta: record.optional()
}).strict();
const resultSchema = z.object({
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
    z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough(),
    z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string().min(1) }).passthrough(),
    z.object({ type: z.literal('resource_link'), uri: z.string().min(1), name: z.string().min(1) }).passthrough(),
    z.object({ type: z.literal('resource'), resource: z.object({ uri: z.string().min(1), text: z.string().optional(), blob: z.string().optional() })
      .passthrough().refine(value => value.text !== undefined || value.blob !== undefined) }).passthrough()
  ])).max(500).optional(), structuredContent: record.optional(), isError: z.boolean().optional(),
  _meta: record.optional()
}).strict().refine(value => value.content !== undefined || value.structuredContent !== undefined);

function compileSchema(schema: Record<string, unknown>): z.ZodType {
  const pending = [{ value: schema as unknown, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 2000 || depth > 16) throw new Error('MCP schema complexity limit exceeded.');
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      // Untrusted regexes cannot run on the host thread. Reference resolution
      // likewise needs a separately bounded validator before it can be admitted.
      if (typeof item.pattern === 'string' || item.patternProperties !== undefined ||
          typeof item.$ref === 'string' || typeof item.$dynamicRef === 'string') throw new Error('Unsupported isolated MCP schema feature.');
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return z.fromJSONSchema(schema);
}

/** Host tool bridge. Existing agent execution supplies durable interrupt approvals. */
export async function createIsolatedMcpTools(options: {
  client: McpClient & { close(): Promise<void> };
  proposal: Readonly<McpStdioLaunchProposal>;
  sensitiveValues?: readonly string[];
  journal?: Pick<Parameters<typeof createJournaledMcpClient>[0], 'store' | 'runId' | 'scope'>;
}): Promise<ToolSet> {
  const proposal = structuredClone(options.proposal);
  const journal = options.journal ? { ...options.journal, scope: structuredClone(options.journal.scope) } : undefined;
  const allow = new Set(proposal.includeTools);
  const validators = new Map<string, z.ZodType>();
  const outputValidators = new Map<string, z.ZodType>();
  const invalidResponse = async (message: string, effectful = false): Promise<never> => {
    try { await options.client.close(); }
    catch { throw new McpStdioClientError('cleanup_required', 'Isolated MCP cleanup was not confirmed.', effectful); }
    throw new McpStdioClientError('protocol', message, effectful);
  };
  const secrets = [...new Set(options.sensitiveValues ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const redaction = createRedactionPolicy({ includeEmails: true });
  const text = (value: string) => redaction.redactText(secrets.reduce((current, secret) => current.split(secret).join('[REDACTED]'), value));
  const scrub = (value: unknown, depth = 0, budget = { nodes: 0 }): unknown => {
    if (depth > 32 || ++budget.nodes > 20000) throw new Error('MCP payload complexity limit exceeded.');
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1, budget));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), scrub(item, depth + 1, budget)]));
    return value;
  };
  const bounded = (value: unknown) => {
    const clean = scrub(value);
    if (Buffer.byteLength(JSON.stringify(value)) > proposal.limits.maxOutputBytes) throw new Error('MCP output limit exceeded.');
    return clean;
  };
  const invoke = async (input: McpCallToolRequest, callOptions?: McpCallToolOptions) => {
      let response;
      try { response = await options.client.callTool(input, callOptions); }
      catch (error) {
        if (error instanceof McpStdioClientError) throw new McpStdioClientError(error.code, 'Isolated MCP call failed.', error.outcomeUnknown);
        throw new Error('Isolated MCP call failed.');
      }
      try {
        const parsed = resultSchema.parse(response);
        const output = outputValidators.get(input.name);
        if (output && !parsed.isError && !output.safeParse(parsed.structuredContent).success) throw new Error('Output schema');
        return bounded(parsed) as Awaited<ReturnType<McpClient['callTool']>>;
      } catch { return invalidResponse('Isolated MCP result validation failed.', true); }
  };
  const validatedClient = { callTool: invoke, listTools: (input: Parameters<McpClient['listTools']>[0], callOptions?: McpCallToolOptions) => options.client.listTools(input, callOptions), close: () => options.client.close() };
  const audited = journal ? createJournaledMcpClient({ ...journal, client: validatedClient, proposal }) : validatedClient;
  const client: McpClient = {
    async listTools(input, callOptions) {
      try {
        const response = await options.client.listTools(input, callOptions);
        const clean = bounded(response);
        // Never silently rewrite a schema or routing identifier to remove a
        // credential. Reject discovery before publishing any of its metadata.
        if (JSON.stringify(clean) !== JSON.stringify(response)) throw new Error('Sensitive discovery');
        const parsed = listing.parse(response);
        for (const tool of parsed.tools) {
          if (!allow.has(tool.name)) continue;
          if (validators.has(tool.name)) throw new Error('Duplicate tool');
          validators.set(tool.name, compileSchema(tool.inputSchema));
          if (tool.outputSchema) outputValidators.set(tool.name, compileSchema(tool.outputSchema));
        }
        return parsed as Awaited<ReturnType<McpClient['listTools']>>;
      } catch { return invalidResponse('Isolated MCP discovery validation failed.'); }
    },
    async callTool(input, callOptions) {
      const validator = validators.get(input.name);
      if (!allow.has(input.name) || !validator) throw new Error('MCP tool was not admitted.');
      const argumentsResult = validator.safeParse(input.arguments ?? {});
      if (!argumentsResult.success) throw new Error('MCP tool arguments failed validation.');
      return audited.callTool({ name: input.name, arguments: argumentsResult.data as JsonValue }, callOptions);
    }
  };
  const configuration: HarnessMcpConfiguration = { schemaVersion: 1, servers: [{
    name: proposal.serverId, transport: 'custom', includeTools: [...allow], includeResources: [], excludeTools: [],
    toolNamePrefix: `mcp_${proposal.serverId.replace(/-/g, '_')}_`, permissions: [...proposal.permissions], headerEnv: {},
    trustServerToolAnnotations: false, maxListPages: 5, maxListedTools: 200, listToolsTimeoutMs: proposal.limits.callMs,
    callToolTimeoutMs: proposal.limits.callMs, maxOutputBytes: proposal.limits.maxOutputBytes
  }] };
  try {
    const tools = await createHarnessMcpTools(configuration, { clients: { [proposal.serverId]: client } });
    if (Object.keys(tools).length !== allow.size) throw new Error('Admitted tools are missing.');
    for (const name of allow) {
      const key = `${configuration.servers[0]!.toolNamePrefix}${name}`;
      const definition = tools[key];
      if (!definition || !('execute' in definition)) throw new Error('Missing callable tool.');
      // Publish the same validator used immediately before dispatch. The SDK's
      // legacy input conversion does not preserve every JSON Schema constraint.
      tools[key] = { ...definition, schema: validators.get(name)!, execute: async (input, context) => {
        if (journal && (context?.runId !== journal.runId || context.scope?.tenantId !== journal.scope.tenantId ||
            context.scope?.userId !== journal.scope.userId || context.scope?.namespace !== journal.scope.namespace || context.toolCall?.name !== key)) {
          throw new Error('MCP execution context does not match its admitted scope.');
        }
        return definition.execute(input, context);
      } };
    }
    return tools;
  }
  catch (error) {
    if (error instanceof McpStdioClientError && error.code === 'cleanup_required') throw error;
    return invalidResponse('Isolated MCP tool discovery failed.');
  }
}
