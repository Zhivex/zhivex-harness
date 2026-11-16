import {test, expect} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {acquireApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {requestLocalServiceDocument} from '../packages/core/src/client/local-transport.js';

async function fixture(stallHello = false) {
  const root = await mkdtemp('/tmp/zhx-deadline-');
  const credentials = {schemaVersion: 1 as const, socketPath: path.join(root, 'host.sock'), token: 'a'.repeat(64)};
  await writeFile(path.join(root, 'coordinator.json'), JSON.stringify(credentials), {mode: 0o600});
  let calls = 0, disconnected = 0;
  const server = createServer(async (req, res) => {
    calls++;
    let body = ''; for await (const chunk of req) body += chunk;
    if (!stallHello && JSON.parse(body).method === 'hello') {
      res.end(JSON.stringify({ok: true, result: {version: 1, capabilities: ['application.state']}})); return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.write(' ');
    const drip = setInterval(() => res.write(' '), 20);
    res.on('close', () => {disconnected++; clearInterval(drip);});
  });
  await new Promise<void>(resolve => server.listen(credentials.socketPath, resolve));
  return {root, credentials, calls: () => calls, disconnected: () => disconnected,
    async close() {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, {recursive: true, force: true});}};
}

test('transport deadline bounds a trickling response and closes the request without replay', async () => {
  const f = await fixture();
  try {
    const started = Date.now();
    await expect(requestLocalServiceDocument(f.credentials, 'application', {method: 'state'}, 100)).rejects.toThrow('LOCAL_SERVICE_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.calls()).toBe(1); expect(f.disconnected()).toBe(1);
  } finally {await f.close();}
});

test('coordinator health read has a short deadline and does not retry a stalled owner', async () => {
  const f = await fixture();
  try {
    const client = await connectCoordinator(f.root), started = Date.now();
    await expect(client.state()).rejects.toThrow('LOCAL_SERVICE_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(4500);
    expect(f.calls()).toBe(2);
  } finally {await f.close();}
}, 6000);

test('a stalled discovery is not treated as permission to take over a live owner', async () => {
  const f = await fixture(true);
  let reads = 0;
  try {
    await expect(acquireApplicationCoordinator(f.root, {secrets: {
      async read() {reads++; return null;}, async write() {},
    }})).rejects.toThrow('LOCAL_SERVICE_TIMEOUT');
    expect(reads).toBe(0); expect(f.calls()).toBe(1);
  } finally {await f.close();}
}, 6000);
