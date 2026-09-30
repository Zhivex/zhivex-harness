import { expect, test } from 'bun:test';
import { IsolatedMcpStdioClient, type IsolatedMcpChannel } from '../src/integrations/mcp-stdio-client.js';
function fixture(handler?: (request: Record<string, unknown>, send: (value: unknown) => void) => void, cleanupFails = false) {
  const queue: Uint8Array[] = []; let wake: (() => void) | undefined; let ended = false; let closes = 0;
  const writes: Record<string, unknown>[] = [];
  const raw = (value: string) => { queue.push(new TextEncoder().encode(value)); wake?.(); };
  const send = (value: unknown) => raw(JSON.stringify(value) + '\n');
  const channel: IsolatedMcpChannel = {
    stdout: { async *[Symbol.asyncIterator]() {
      while (!ended) { if (queue.length) yield queue.shift()!; else await new Promise<void>(resolve => { wake = resolve; }); }
    } },
    async write(frame) {
      const request = JSON.parse(new TextDecoder().decode(frame)); writes.push(request);
      if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: {} } });
      else if (request.method !== 'notifications/initialized') handler?.(request, send);
    },
    async close() { closes++; ended = true; wake?.(); if (cleanupFails) throw new Error('secret-cleanup'); }
  };
  const client = new IsolatedMcpStdioClient(channel, { callMs: 20, initializeMs: 200, sessionMs: 1000, maxFrameBytes: 4096 });
  return { client, writes, raw, closes: () => closes };
}

test('initializes before discovery, correlates replies and closes owner once', async () => {
  const f = fixture((request, send) => send({ jsonrpc: '2.0', id: request.id,
    result: request.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'ok' }] } }));
  await expect(f.client.listTools()).rejects.toThrow('not initialized');
  await f.client.initialize();
  expect(await f.client.listTools()).toEqual({ tools: [] });
  expect(await f.client.callTool({ name: 'lookup' })).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  await f.client.close(); await f.client.close();
  expect(f.closes()).toBe(1);
  expect(f.writes.map(x => x.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});

test('hung effectful call times out with unknown outcome and cannot replay', async () => {
  const f = fixture(); await f.client.initialize();
  const error = await f.client.callTool({ name: 'write' }).catch(error => error);
  expect(error.code).toBe('timeout'); expect(error.outcomeUnknown).toBe(true);
  await expect(f.client.callTool({ name: 'write' })).rejects.toThrow('closed');
  await f.client.close(); expect(f.closes()).toBe(1);
  expect(f.writes.filter(x => x.method === 'tools/call')).toHaveLength(1);
});

test('abort cancels in-flight call, denies concurrent request and cleans boundary', async () => {
  const f = fixture(); await f.client.initialize();
  const abort = new AbortController();
  const pending = f.client.callTool({ name: 'write' }, { abortSignal: abort.signal }).catch(error => error);
  await expect(f.client.listTools()).rejects.toThrow('active request');
  abort.abort(); expect((await pending).code).toBe('cancelled');
  await f.client.close(); expect(f.closes()).toBe(1);
});

for (const output of ['secret-canary\n', '{"jsonrpc":"2.0","id":999,"result":{}}\n',
  '{"jsonrpc":"2.0","id":4,"method":"sampling/createMessage"}\n']) {
  test(`invalid or unsolicited server output fails closed: ${output.slice(0, 25)}`, async () => {
    const f = fixture(); await f.client.initialize();
    const pending = f.client.callTool({ name: 'lookup' }).catch(error => error);
    f.raw(output); const error = await pending;
    expect(error.code).toBe('protocol'); expect(String(error)).not.toContain('secret-canary');
    await f.client.close(); expect(f.closes()).toBe(1);
  });
}

test('cleanup failure remains visible and never becomes successful close', async () => {
  const f = fixture(undefined, true); await f.client.initialize();
  await expect(f.client.close()).rejects.toThrow('cleanup was not confirmed');
  await expect(f.client.close()).rejects.toThrow('cleanup was not confirmed');
  expect(f.closes()).toBe(1);
});

test('cleanup that never settles has a bounded failure', async () => {
  const channel: IsolatedMcpChannel = {
    stdout: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } },
    async write() {}, async close() { await new Promise(() => {}); }
  };
  const client = new IsolatedMcpStdioClient(channel, { callMs: 20, initializeMs: 20, sessionMs: 1000, maxFrameBytes: 1024, closeMs: 5 });
  await expect(client.close()).rejects.toThrow('cleanup was not confirmed');
});

test('duplicate response in one chunk cannot yield accepted success', async () => {
  const f = fixture(request => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\n';
    f.raw(line + line);
  });
  await f.client.initialize();
  await expect(f.client.listTools()).rejects.toThrow('stopped before response acceptance');
  await expect(f.client.listTools()).rejects.toThrow('closed');
  await f.client.close();
});
