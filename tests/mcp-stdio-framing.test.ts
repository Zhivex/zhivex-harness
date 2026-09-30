import { expect, test } from 'bun:test';
import { McpStdioFrameDecoder, type McpStdioMessage } from '../src/integrations/mcp-stdio-framing.js';
const bytes = (value: string) => new TextEncoder().encode(value);
const response: McpStdioMessage = { jsonrpc: '2.0', id: 1, result: { text: 'á😀' } };

test('fragmented UTF-8 and coalesced frames preserve exact messages without a retained queue', () => {
  const messages: McpStdioMessage[] = [];
  const decoder = new McpStdioFrameDecoder(1024, message => messages.push(message));
  const line = bytes(JSON.stringify(response) + '\n');
  for (const byte of line) decoder.push(new Uint8Array([byte]));
  decoder.push(bytes('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"result":null}\n'));
  decoder.finish();
  expect(messages).toEqual([response, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, result: null }]);
});

test('limits count bytes and reject an oversized unfinished frame before callback', () => {
  let calls = 0;
  const line = JSON.stringify(response);
  const decoder = new McpStdioFrameDecoder(bytes(line).length - 1, () => calls++);
  expect(() => decoder.push(bytes(line))).toThrow('byte limit');
  expect(calls).toBe(0);
  expect(() => decoder.push(bytes('{}\n'))).toThrow('closed');
});

test('exact byte limit accepts newline and EOF rejects truncated frames', () => {
  const line = JSON.stringify(response);
  const decoder = new McpStdioFrameDecoder(bytes(line).length, () => {});
  decoder.push(bytes(line + '\n')); decoder.finish();
  const truncated = new McpStdioFrameDecoder(128, () => {});
  truncated.push(bytes('{"jsonrpc":"2.0"'));
  expect(() => truncated.finish()).toThrow('incomplete');
  truncated.finish();
});

for (const value of ['server log secret-canary', '[]', '{}', '{"jsonrpc":"2.0","id":1,"result":0,"error":{}}',
  '{"jsonrpc":"2.0","method":"x","id":null}', '{"jsonrpc":"2.0","method":"x","params":1}',
  '{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":"secret-canary"}}']) {
  test(`reject malformed envelope: ${value.slice(0, 35)}`, () => {
    let calls = 0;
    const decoder = new McpStdioFrameDecoder(1024, () => calls++);
    let error: unknown;
    try { decoder.push(bytes(value + '\n')); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('secret-canary');
    expect(calls).toBe(0);
  });
}

test('invalid UTF-8 is rejected and handler failure terminates further dispatch', () => {
  const bad = new McpStdioFrameDecoder(1024, () => {});
  expect(() => bad.push(new Uint8Array([0xff, 10]))).toThrow('UTF-8');
  let calls = 0;
  const decoder = new McpStdioFrameDecoder(1024, () => { calls++; throw new Error('stop'); });
  expect(() => decoder.push(bytes(JSON.stringify(response) + '\n' + JSON.stringify(response) + '\n'))).toThrow('stop');
  expect(calls).toBe(1);
  expect(() => decoder.push(bytes(JSON.stringify(response) + '\n'))).toThrow('closed');
});

test('retained partial frames do not alias caller-owned Buffer memory', () => {
  const messages: McpStdioMessage[] = [];
  const decoder = new McpStdioFrameDecoder(1024, message => messages.push(message));
  const prefix = Buffer.from('{"jsonrpc":"2.0","id":1,');
  decoder.push(prefix);
  prefix.fill(0xff);
  decoder.push(bytes('"result":null}\n'));
  expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: null }]);
});
