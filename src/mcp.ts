import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  createMcpToolSet,
  serializeJsonValue,
  type JsonValue,
  type McpCallToolOptions,
  type McpCallToolRequest,
  type McpCallToolResponse,
  type McpClient,
  type McpListedTool,
  type McpListToolsRequest,
  type McpListToolsResponse,
  type ToolSet
} from "@zhivex-ai/core";
import { z } from "zod";

import {
  HarnessConfigError,
  HarnessError,
  HarnessExecutionError,
  HarnessProviderError,
  HarnessWorkspaceError
} from "./errors.js";
import { HARNESS_VERSION } from "./version.js";

export const HARNESS_MCP_CONFIG_SCHEMA_VERSION = 1 as const;
export const HARNESS_MCP_PERMISSIONS = [
  "read",
  "network",
  "write",
  "external-side-effect"
] as const;

export type HarnessMcpPermission = (typeof HARNESS_MCP_PERMISSIONS)[number];
export type HarnessMcpTransport = "http" | "custom";

export interface HarnessMcpServerConfig {
  name: string;
  transport: HarnessMcpTransport;
  url?: string;
  includeTools: readonly string[];
  excludeTools: readonly string[];
  toolNamePrefix: string;
  permissions: readonly HarnessMcpPermission[];
  headerEnv: Readonly<Record<string, string>>;
  trustServerToolAnnotations: boolean;
  maxListPages: number;
  maxListedTools: number;
  listToolsTimeoutMs: number;
  callToolTimeoutMs: number;
  maxOutputBytes: number;
}

export interface HarnessMcpConfiguration {
  schemaVersion: typeof HARNESS_MCP_CONFIG_SCHEMA_VERSION;
  servers: readonly HarnessMcpServerConfig[];
}

export type HarnessMcpClients = Readonly<Record<string, McpClient>>;

const identifier = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const toolName = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const serverSchema = z.object({
  name: identifier,
  transport: z.enum(["http", "custom"]),
  url: z.string().max(2_048).optional(),
  includeTools: z.array(toolName).min(1).max(200),
  excludeTools: z.array(toolName).max(200).default([]),
  toolNamePrefix: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional(),
  permissions: z.array(z.enum(HARNESS_MCP_PERMISSIONS)).min(1).max(4),
  headerEnv: z.record(
    z.string().min(1).max(128).regex(/^[A-Za-z0-9-]+$/),
    z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  ).default({}),
  trustServerToolAnnotations: z.boolean().default(false),
  maxListPages: z.number().int().min(1).max(20).default(5),
  maxListedTools: z.number().int().min(1).max(500).default(100),
  listToolsTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),
  callToolTimeoutMs: z.number().int().min(100).max(10 * 60_000).default(30_000),
  maxOutputBytes: z.number().int().min(1_024).max(4 * 1024 * 1024).default(256 * 1024)
}).strict();

const configurationSchema = z.object({
  schemaVersion: z.literal(HARNESS_MCP_CONFIG_SCHEMA_VERSION),
  servers: z.array(serverSchema).max(20)
}).strict();

const isInsidePath = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const validatedHttpUrl = (value: string, serverName: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MCP server ${serverName} has an invalid URL.`);
  }
  const loopback = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`MCP server ${serverName} must use HTTPS or loopback HTTP.`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`MCP server ${serverName} URL cannot contain credentials or a fragment.`);
  }
  return url.toString();
};

const forbiddenHeaders = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding"
]);

const normalizeHarnessMcpConfigurationUnsafe = (value: unknown): HarnessMcpConfiguration => {
  const parsed = configurationSchema.parse(value);
  const names = new Set<string>();
  const prefixes = new Set<string>();
  const servers = parsed.servers.map((server): HarnessMcpServerConfig => {
    if (names.has(server.name)) {
      throw new Error(`Duplicate MCP server name: ${server.name}.`);
    }
    names.add(server.name);
    const prefix = server.toolNamePrefix ?? `${server.name}_`;
    if (prefixes.has(prefix)) {
      throw new Error(`Duplicate MCP tool prefix: ${prefix}.`);
    }
    prefixes.add(prefix);
    const includeTools = [...new Set(server.includeTools)];
    const excludeTools = [...new Set(server.excludeTools)];
    if (includeTools.some((name) => excludeTools.includes(name))) {
      throw new Error(`MCP server ${server.name} includes and excludes the same tool.`);
    }
    for (const header of Object.keys(server.headerEnv)) {
      if (forbiddenHeaders.has(header.toLowerCase())) {
        throw new Error(`MCP server ${server.name} cannot configure header ${header}.`);
      }
    }
    if (server.transport === "http" && !server.url) {
      throw new Error(`MCP server ${server.name} requires url for HTTP transport.`);
    }
    if (server.transport === "custom" && server.url) {
      throw new Error(`MCP server ${server.name} cannot set url for custom transport.`);
    }
    if (server.transport === "http" && !server.permissions.includes("network")) {
      throw new Error(`MCP server ${server.name} must declare the network permission.`);
    }
    const annotationTrustAllowed = server.transport === "custom" &&
      server.permissions.length === 1 &&
      server.permissions[0] === "read";
    if (server.trustServerToolAnnotations && !annotationTrustAllowed) {
      throw new Error(
        `MCP server ${server.name} can trust annotations only for an injected read-only custom transport.`
      );
    }
    return {
      name: server.name,
      transport: server.transport,
      ...(server.url ? { url: validatedHttpUrl(server.url, server.name) } : {}),
      includeTools,
      excludeTools,
      toolNamePrefix: prefix,
      permissions: [...new Set(server.permissions)],
      headerEnv: { ...server.headerEnv },
      trustServerToolAnnotations: server.trustServerToolAnnotations,
      maxListPages: server.maxListPages,
      maxListedTools: server.maxListedTools,
      listToolsTimeoutMs: server.listToolsTimeoutMs,
      callToolTimeoutMs: server.callToolTimeoutMs,
      maxOutputBytes: server.maxOutputBytes
    };
  });
  return { schemaVersion: HARNESS_MCP_CONFIG_SCHEMA_VERSION, servers };
};

export const normalizeHarnessMcpConfiguration = (value: unknown): HarnessMcpConfiguration => {
  try {
    return normalizeHarnessMcpConfigurationUnsafe(value);
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessConfigError(
      error instanceof Error ? error.message : "Harness MCP configuration is invalid.",
      { cause: error }
    );
  }
};

const loadHarnessMcpConfigurationUnsafe = async (
  workspace: string,
  configPath: string
): Promise<HarnessMcpConfiguration> => {
  const entry = await lstat(configPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new HarnessWorkspaceError(`MCP configuration must be a regular non-symlink file: ${configPath}.`);
  }
  if (entry.size > 1024 * 1024) {
    throw new HarnessConfigError("MCP configuration cannot exceed 1 MiB.");
  }
  const [canonicalWorkspace, canonicalConfig] = await Promise.all([
    realpath(workspace),
    realpath(configPath)
  ]);
  if (!isInsidePath(canonicalWorkspace, canonicalConfig)) {
    throw new HarnessWorkspaceError("MCP configuration must remain inside the canonical workspace.");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(canonicalConfig, "utf8"));
  } catch (error) {
    throw new HarnessConfigError("MCP configuration is not valid JSON.", { cause: error });
  }
  return normalizeHarnessMcpConfiguration(value);
};

export const loadHarnessMcpConfiguration = async (
  workspace: string,
  configPath: string
): Promise<HarnessMcpConfiguration> => {
  try {
    return await loadHarnessMcpConfigurationUnsafe(workspace, configPath);
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessWorkspaceError(`MCP configuration could not be read safely: ${configPath}.`, {
      cause: error
    });
  }
};

const promptInjectionPatterns = [
  /ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier)\s+instructions/i,
  /(?:system|developer)\s+(?:message|prompt|instruction)/i,
  /reveal.{0,40}(?:secret|token|api[ -]?key|credential)/i,
  /<\s*(?:script|iframe)\b/i
];

const assertSafeMcpPayload = (serverName: string, value: unknown) => {
  const serialized = JSON.stringify(value);
  const matched = promptInjectionPatterns.find((pattern) => pattern.test(serialized));
  if (matched) {
    throw new HarnessExecutionError(`MCP server ${serverName} returned probable prompt-injection content.`);
  }
  return serialized;
};

const boundedClient = (client: McpClient, server: HarnessMcpServerConfig): McpClient => ({
  async listTools(input?: McpListToolsRequest, options?: McpCallToolOptions) {
    const result = await client.listTools(input, options);
    const serialized = assertSafeMcpPayload(server.name, result);
    if (new TextEncoder().encode(serialized).byteLength > server.maxOutputBytes) {
      throw new HarnessExecutionError(`MCP server ${server.name} tool discovery exceeded ${server.maxOutputBytes} bytes.`);
    }
    return result;
  },
  async callTool(input: McpCallToolRequest, options?: McpCallToolOptions) {
    const result = await client.callTool(input, options);
    const serialized = assertSafeMcpPayload(server.name, result);
    if (new TextEncoder().encode(serialized).byteLength > server.maxOutputBytes) {
      throw new HarnessExecutionError(`MCP server ${server.name} result exceeded ${server.maxOutputBytes} bytes.`);
    }
    return result;
  }
});

const resolveHeaders = (server: HarnessMcpServerConfig, env: NodeJS.ProcessEnv) => {
  const headers: Record<string, string> = {};
  for (const [header, variable] of Object.entries(server.headerEnv)) {
    const value = env[variable]?.trim();
    if (!value) {
      throw new Error(`MCP server ${server.name} requires environment variable ${variable}.`);
    }
    if (/\r|\n|\u0000/.test(value)) {
      throw new Error(`MCP server ${server.name} environment variable ${variable} is not a safe header value.`);
    }
    headers[header] = value;
  }
  return headers;
};

const readBoundedBody = async (response: Response, limit: number) => {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HarnessExecutionError(`MCP HTTP response exceeded ${limit} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

const parseHttpPayload = (body: string, contentType: string | null): unknown => {
  if (!body.trim()) return undefined;
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    const data = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .at(-1);
    if (!data) {
      throw new Error("MCP HTTP server returned an empty event stream.");
    }
    return JSON.parse(data);
  }
  return JSON.parse(body);
};

type FetchImplementation = typeof fetch;

export const createHttpMcpClient = (
  server: HarnessMcpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch
): McpClient => {
  if (server.transport !== "http" || !server.url) {
    throw new HarnessConfigError(`MCP server ${server.name} is not configured for HTTP transport.`);
  }
  let staticHeaders: Record<string, string>;
  try {
    staticHeaders = resolveHeaders(server, env);
  } catch (error) {
    throw new HarnessConfigError(`MCP server ${server.name} headers are not configured safely.`, { cause: error });
  }
  let sessionId: string | undefined;
  let requestId = 0;
  let initialization: Promise<void> | undefined;

  const post = async (
    payload: Record<string, JsonValue | undefined>,
    options: McpCallToolOptions = {},
    expectResponse = true
  ) => {
    let response: Response;
    try {
      response = await fetchImplementation(server.url!, {
        method: "POST",
        redirect: "error",
        headers: {
          ...staticHeaders,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {})
        },
        body: JSON.stringify(payload),
        ...(options.abortSignal ? { signal: options.abortSignal } : {})
      });
    } catch (error) {
      throw new HarnessProviderError(`MCP server ${server.name} could not be reached.`, {
        cause: error,
        retryable: true
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HarnessProviderError(`MCP server ${server.name} returned HTTP ${response.status}.`, {
        cause: Object.assign(new Error("MCP HTTP failure"), { status: response.status }),
        retryable: response.status === 429 || response.status >= 500
      });
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!expectResponse) {
      await response.body?.cancel();
      return undefined;
    }
    const body = await readBoundedBody(response, server.maxOutputBytes);
    try {
      return parseHttpPayload(body, response.headers.get("content-type"));
    } catch (error) {
      throw new HarnessExecutionError(`MCP server ${server.name} returned an invalid response.`, { cause: error });
    }
  };

  const rpc = async (
    method: string,
    params: JsonValue | undefined,
    options: McpCallToolOptions = {}
  ) => {
    const id = ++requestId;
    const payload = await post({ jsonrpc: "2.0", id, method, params }, options);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new HarnessExecutionError(`MCP server ${server.name} returned an invalid JSON-RPC response.`);
    }
    const record = payload as Record<string, unknown>;
    if (record.id !== id) {
      throw new HarnessExecutionError(`MCP server ${server.name} returned a mismatched JSON-RPC id.`);
    }
    if (record.error && typeof record.error === "object") {
      const message = (record.error as { message?: unknown }).message;
      throw new HarnessExecutionError(
        `MCP server ${server.name} JSON-RPC error: ${typeof message === "string" ? message : "unknown error"}.`
      );
    }
    return record.result;
  };

  const ensureInitialized = (options: McpCallToolOptions = {}) => {
    initialization ??= (async () => {
      const result = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "zhivex-harness", version: HARNESS_VERSION }
      }, options);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new HarnessExecutionError(`MCP server ${server.name} returned an invalid initialize result.`);
      }
      const negotiatedVersion = (result as { protocolVersion?: unknown }).protocolVersion;
      if (negotiatedVersion !== "2025-06-18") {
        throw new HarnessExecutionError(
          `MCP server ${server.name} negotiated unsupported protocol version ${String(negotiatedVersion)}.`
        );
      }
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, options, false);
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };

  return {
    async listTools(input: McpListToolsRequest = {}, options: McpCallToolOptions = {}) {
      await ensureInitialized(options);
      const result = await rpc("tools/list", input as JsonValue, options);
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new HarnessExecutionError(`MCP server ${server.name} returned an invalid tools/list result.`);
      }
      const tools = (result as { tools?: unknown }).tools;
      if (!Array.isArray(tools)) {
        throw new HarnessExecutionError(`MCP server ${server.name} tools/list result has no tools array.`);
      }
      return result as McpListToolsResponse;
    },
    async callTool(input: McpCallToolRequest, options: McpCallToolOptions = {}) {
      await ensureInitialized(options);
      return await rpc("tools/call", {
        name: input.name,
        ...(input.arguments === undefined ? {} : { arguments: input.arguments })
      }, options) as JsonValue | McpCallToolResponse;
    }
  };
};

export const createHarnessMcpTools = async (
  configuration: HarnessMcpConfiguration,
  options: {
    clients?: HarnessMcpClients;
    env?: NodeJS.ProcessEnv;
    fetchImplementation?: FetchImplementation;
  } = {}
): Promise<ToolSet> => {
  const tools: ToolSet = {};
  for (const server of configuration.servers) {
    const injected = options.clients?.[server.name];
    const client = injected ?? (server.transport === "http"
      ? createHttpMcpClient(server, options.env ?? process.env, options.fetchImplementation ?? fetch)
      : undefined);
    if (!client) {
      throw new HarnessConfigError(`MCP server ${server.name} requires an injected custom client.`);
    }
    const discovered = await createMcpToolSet(boundedClient(client, server), {
      toolNamePrefix: server.toolNamePrefix,
      includeTools: [...server.includeTools],
      excludeTools: [...server.excludeTools],
      trustServerToolAnnotations: server.trustServerToolAnnotations,
      maxListPages: server.maxListPages,
      maxListedTools: server.maxListedTools,
      listToolsTimeoutMs: server.listToolsTimeoutMs,
      callToolTimeoutMs: server.callToolTimeoutMs,
      approvalMode: "interrupt"
    });
    const requiresApproval = server.permissions.some((permission) => permission !== "read");
    for (const [name, definition] of Object.entries(discovered)) {
      if (tools[name]) {
        throw new HarnessExecutionError(`Duplicate harness tool name after MCP discovery: ${name}.`);
      }
      if (!("execute" in definition)) {
        throw new HarnessExecutionError(`MCP server ${server.name} produced a non-callable tool ${name}.`);
      }
      const effectiveRequiresApproval = requiresApproval || definition.requiresApproval === true;
      tools[name] = {
        ...definition,
        requiresApproval: effectiveRequiresApproval,
        ...(effectiveRequiresApproval
          ? { approvalMode: "interrupt" as const }
          : definition.approvalMode
            ? { approvalMode: definition.approvalMode }
            : {}),
        metadata: serializeJsonValue({
          ...(definition.metadata ?? {}),
          source: "mcp",
          server: server.name,
          untrustedContent: true,
          advancedRegistry: {
            permissions: server.permissions,
            audit: {
              riskLevel: requiresApproval ? "high" : "low"
            }
          }
        }) as Record<string, JsonValue>
      };
    }
  }
  return tools;
};

export const mcpConfigurationFingerprintInput = (configuration: HarnessMcpConfiguration) =>
  serializeJsonValue(configuration);

export type { McpClient, McpListedTool };
