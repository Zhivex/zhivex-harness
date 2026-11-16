/** Internal codec only. It does not spawn processes, admit servers or grant tools. */
export type McpStdioMessage = Record<string, unknown> & { jsonrpc: '2.0' };

export class McpStdioProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'McpStdioProtocolError'; }
}

const validId = (id: unknown) => typeof id === 'string' ? id.length <= 256
  : typeof id === 'number' && Number.isSafeInteger(id);

function parseMessage(bytes: Uint8Array): McpStdioMessage {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new McpStdioProtocolError('Invalid MCP stdio UTF-8 or JSON frame.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpStdioProtocolError('Invalid MCP stdio message envelope.');
  }
  const message = value as Record<string, unknown>;
  const has = (key: string) => Object.hasOwn(message, key);
  const request = typeof message.method === 'string' && message.method.length > 0 && message.method.length <= 256;
  const response = !has('method') && has('id') && (has('result') !== has('error'));
  if (message.jsonrpc !== '2.0' || (!request && !response) ||
      (request && (has('result') || has('error'))) ||
      (has('id') && !validId(message.id)) ||
      (has('params') && (!message.params || typeof message.params !== 'object')) ||
      (response && has('params'))) {
    throw new McpStdioProtocolError('Invalid MCP stdio message envelope.');
  }
  if (has('error')) {
    const error = message.error;
    if (!error || typeof error !== 'object' || Array.isArray(error) ||
        !Number.isSafeInteger((error as Record<string, unknown>).code) ||
        typeof (error as Record<string, unknown>).message !== 'string') {
      throw new McpStdioProtocolError('Invalid MCP stdio error envelope.');
    }
  }
  return message as McpStdioMessage;
}

/** Byte limits apply before UTF-8 decoding, including an unfinished line. */
export class McpStdioFrameDecoder {
  private readonly frame: Uint8Array;
  private size = 0;
  private ended = false;
  constructor(private readonly maxFrameBytes: number, private readonly onMessage: (message: McpStdioMessage) => void) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 1024 * 1024) {
      throw new RangeError('MCP stdio frame limit must be between 1 and 1048576 bytes.');
    }
    this.frame = new Uint8Array(maxFrameBytes);
  }
  push(chunk: Uint8Array): void {
    if (this.ended) throw new McpStdioProtocolError('MCP stdio decoder is closed.');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - offset;
        if (this.size + length > this.maxFrameBytes) throw new McpStdioProtocolError('MCP stdio frame exceeds byte limit.');
        if (length) { this.frame.set(chunk.subarray(offset, end), this.size); this.size += length; }
        if (newline === -1) return;
        const message = parseMessage(this.frame.subarray(0, this.size));
        this.size = 0;
        this.onMessage(message);
        offset = newline + 1;
      }
    } catch (error) {
      this.ended = true; this.frame.fill(0); this.size = 0;
      throw error;
    }
  }
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    const incomplete = this.size > 0;
    this.frame.fill(0); this.size = 0;
    if (incomplete) throw new McpStdioProtocolError('MCP stdio ended with an incomplete frame.');
  }
}
