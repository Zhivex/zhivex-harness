import type { McpCallToolOptions, McpCallToolRequest, McpCallToolResponse, McpClient, McpListToolsRequest, McpListToolsResponse } from '@zhivex-ai/core';
import { McpStdioFrameDecoder, McpStdioProtocolError, type McpStdioMessage } from './mcp-stdio-framing.js';

/** Supplied only by the admitted isolated-process owner. No executable or spawn API. */
export interface IsolatedMcpChannel {
  stdout: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): Promise<void>;
  /** Resolves only after the entire boundary/process tree has been removed. */
  close(): Promise<void>;
}
export class McpStdioClientError extends Error {
  constructor(readonly code: 'closed' | 'busy' | 'timeout' | 'cancelled' | 'protocol' | 'remote' | 'cleanup_required', message: string,
    readonly outcomeUnknown = false) { super(message); this.name = 'McpStdioClientError'; }
}
type Pending = { id: number; effectful: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Internal protocol client. Admission, isolated launch and per-tool approval belong to the host. */
export class IsolatedMcpStdioClient implements McpClient {
  private nextId = 1;
  private pending: Pending | undefined;
  private stopped = false;
  private ready = false;
  private initializing = false;
  private closing: Promise<void> | undefined;
  private readonly decoder: McpStdioFrameDecoder;
  private readonly reading: Promise<void>;
  constructor(private readonly channel: IsolatedMcpChannel, private readonly limits: {
    callMs: number; initializeMs: number; sessionMs: number; maxFrameBytes: number; closeMs?: number;
  }) {
    for (const value of [limits.callMs, limits.initializeMs, limits.sessionMs, limits.closeMs ?? 2000]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) throw new RangeError('Invalid MCP deadline.');
    }
    this.decoder = new McpStdioFrameDecoder(limits.maxFrameBytes, message => this.receive(message));
    this.reading = this.read();
    this.sessionTimer = setTimeout(() => this.fail('timeout', 'MCP session deadline exceeded.'), limits.sessionMs);
  }
  private readonly sessionTimer: ReturnType<typeof setTimeout>;
  private receive(message: McpStdioMessage) {
    if (this.stopped) return;
    if ('method' in message) {
      // No server-originated capabilities are admitted by this initial client.
      throw new McpStdioProtocolError('Unsolicited MCP server message.');
    }
    if (!this.pending || message.id !== this.pending.id) throw new McpStdioProtocolError('Unknown or duplicate MCP response ID.');
    const pending = this.pending; this.pending = undefined;
    if ('error' in message) pending.reject(new McpStdioClientError('remote', 'MCP server rejected the request.', pending.effectful));
    else pending.resolve(message.result);
  }
  private async read() {
    try {
      for await (const chunk of this.channel.stdout) {
        if (this.stopped) break;
        // Fail before iterator.return() can yield and let an earlier response settle.
        try { this.decoder.push(chunk); } catch {
          this.fail('protocol', 'MCP server output is invalid.'); break;
        }
      }
      if (!this.stopped) { this.decoder.finish(); this.fail('closed', 'MCP server closed its output.'); }
    } catch { if (!this.stopped) this.fail('protocol', 'MCP server output is invalid.'); }
  }
  private fail(code: McpStdioClientError['code'], message: string) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.sessionTimer);
    const pending = this.pending; this.pending = undefined;
    pending?.reject(new McpStdioClientError(code, message, pending.effectful));
    // Capture rejection until the owner awaits close; cleanup failure is never success.
    this.closing = this.boundedCleanup(Promise.resolve().then(() => this.channel.close())).catch(() => {
      throw new McpStdioClientError('cleanup_required', 'MCP isolated boundary cleanup was not confirmed.');
    });
    void this.closing.catch(() => {});
  }
  private async request(method: string, params: unknown, timeout: number, options?: McpCallToolOptions, effectful = false): Promise<unknown> {
    if (this.stopped) throw new McpStdioClientError('closed', 'MCP client is closed.');
    if (this.pending) throw new McpStdioClientError('busy', 'MCP client already has an active request.');
    if (options?.abortSignal?.aborted) throw new McpStdioClientError('cancelled', 'MCP request cancelled before dispatch.');
    if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new RangeError('Invalid MCP request deadline.');
    const frame = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: this.nextId, method, params }) + '\n');
    if (frame.length - 1 > this.limits.maxFrameBytes) throw new McpStdioClientError('protocol', 'MCP request exceeds frame limit.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => this.fail('cancelled', 'MCP request cancelled after dispatch.');
    try {
      const result = await new Promise((resolve, reject) => {
        this.pending = { id: this.nextId++, effectful, resolve, reject };
        timer = setTimeout(() => this.fail('timeout', 'MCP request deadline exceeded.'), Math.min(timeout, options?.timeoutMs ?? timeout));
        options?.abortSignal?.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { if (!this.stopped) return this.channel.write(frame); }).catch(() => this.fail('closed', 'MCP request transport failed.'));
      });
      if (this.stopped) throw new McpStdioClientError('protocol', 'MCP client stopped before response acceptance.', effectful);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options?.abortSignal?.removeEventListener('abort', abort);
    }
  }
  async initialize(): Promise<void> {
    try { await this.initializeInternal(); } catch (error) {
      this.fail('protocol', 'MCP initialization failed.'); throw error;
    }
  }
  private async initializeInternal(): Promise<void> {
    if (this.ready || this.initializing) throw new McpStdioClientError('protocol', 'MCP client was already initialized.');
    this.initializing = true;
    const deadline = performance.now() + this.limits.initializeMs;
    const result = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'zhivex-harness', version: '1' } }, this.limits.initializeMs);
    if (!result || typeof result !== 'object' || (result as Record<string, unknown>).protocolVersion !== '2025-11-25') {
      this.fail('protocol', 'Unsupported MCP initialization response.');
      throw new McpStdioClientError('protocol', 'Unsupported MCP initialization response.');
    }
    try {
      // Initialization response and notification share one absolute deadline.
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.channel.write(new TextEncoder().encode('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), remaining); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      if (this.stopped) throw new Error('closed');
      this.ready = true;
    } catch {
      this.fail('protocol', 'MCP initialization did not complete.');
      throw new McpStdioClientError('protocol', 'MCP initialization did not complete.');
    }
  }
  async listTools(input?: McpListToolsRequest, options?: McpCallToolOptions): Promise<McpListToolsResponse> {
    if (!this.ready) throw new McpStdioClientError('protocol', 'MCP client is not initialized.');
    const result = await this.request('tools/list', input ?? {}, this.limits.callMs, options);
    if (!result || typeof result !== 'object' || !Array.isArray((result as Record<string, unknown>).tools)) {
      this.fail('protocol', 'Invalid MCP tool listing.'); throw new McpStdioClientError('protocol', 'Invalid MCP tool listing.');
    }
    return result as McpListToolsResponse;
  }
  async callTool(input: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpCallToolResponse> {
    if (!this.ready) throw new McpStdioClientError('protocol', 'MCP client is not initialized.');
    const result = await this.request('tools/call', input, this.limits.callMs, options, true);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      this.fail('protocol', 'Invalid MCP tool result.'); throw new McpStdioClientError('protocol', 'Invalid MCP tool result.', true);
    }
    return result as McpCallToolResponse;
  }
  private async boundedCleanup(operation: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpStdioClientError('cleanup_required', 'MCP isolated boundary cleanup was not confirmed.')), this.limits.closeMs ?? 2000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.fail('closed', 'MCP client was closed.');
    await this.closing;
    await this.boundedCleanup(this.reading);
  }
}
