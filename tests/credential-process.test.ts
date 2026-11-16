import {test, expect} from 'bun:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createProcessSecretStore} from '../packages/core/src/application/credential-process.js';
import {startManagedAssistant} from '../packages/core/src/application/assistant/managed/setup.js';

async function fixture() {
  const directory = await mkdtemp('/tmp/zhx-credential-process-');
  const entry = directory + '/worker.mjs';
  await writeFile(directory + '/mode', 'normal');
  await writeFile(entry, `import fs from 'node:fs';
const dir = process.argv[2]; fs.writeFileSync(dir + '/pid', String(process.pid));
const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const request = JSON.parse(Buffer.concat(chunks).toString('utf8')), mode = fs.readFileSync(dir + '/mode', 'utf8');
if (mode === 'hang-read' && request.operation === 'read') setInterval(() => {}, 1000);
else if (request.operation === 'write') {
 fs.writeFileSync(dir + '/saved', request.value);
 if (mode === 'uncertain-write') setInterval(() => {}, 1000);
 else process.stdout.write(JSON.stringify({ok: true}));
} else process.stdout.write(JSON.stringify({ok: true, value: fs.existsSync(dir + '/saved') ? fs.readFileSync(dir + '/saved', 'utf8') : null}));
`);
  const store = await createProcessSecretStore(directory, {executable: 'node', entry, args: [directory], timeoutMs: 500});
  return {directory, store};
}

test('isolated read timeout terminates the native worker before admitting a retry', async () => {
  const {directory, store} = await fixture();
  try {
    await writeFile(directory + '/mode', 'hang-read');
    const pending = store.read();
    await expect(store.read()).rejects.toThrow('SETUP_KEYCHAIN_BUSY');
    await expect(pending).rejects.toThrow('SETUP_KEYCHAIN_UNAVAILABLE');
    const pid = Number(await readFile(directory + '/pid', 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    await writeFile(directory + '/mode', 'normal');
    expect(await store.read()).toBeNull();
    const secret = 'private 🔐 café '.repeat(10000);
    await store.write(secret); expect(await store.read() === secret).toBe(true);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('unconfirmed write cannot be repeated before a successful read reconciles durable bytes', async () => {
  const {directory, store} = await fixture();
  try {
    await writeFile(directory + '/mode', 'uncertain-write');
    await expect(store.write('saved without acknowledgement')).rejects.toThrow('SETUP_KEYCHAIN_WRITE_UNCONFIRMED');
    const pid = await readFile(directory + '/pid', 'utf8');
    expect(() => process.kill(Number(pid), 0)).toThrow();
    await expect(store.write('must not overwrite')).rejects.toThrow('SETUP_KEYCHAIN_RECONCILE_REQUIRED');
    expect(await readFile(directory + '/pid', 'utf8')).toBe(pid);
    expect(await store.read()).toBe('saved without acknowledgement');
    await writeFile(directory + '/mode', 'normal');
    await store.write('explicit next change'); expect(await store.read()).toBe('explicit next change');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('manager locks after an uncertain save and reloads the committed draft on explicit retry', async () => {
  const {directory, store} = await fixture();
  const manager = await startManagedAssistant(directory + '/app', {secrets: store});
  try {
    await writeFile(directory + '/mode', 'uncertain-write');
    await expect(manager.action('begin', {name: 'Saved draft'})).rejects.toThrow('SETUP_KEYCHAIN_WRITE_UNCONFIRMED');
    expect(manager.state()).toMatchObject({locked: true, error: 'SETUP_KEYCHAIN_WRITE_UNCONFIRMED'});
    await expect(manager.action('begin', {name: 'Do not overwrite'})).rejects.toThrow('SETUP_KEYCHAIN_UNAVAILABLE');
    await writeFile(directory + '/mode', 'normal');
    await manager.action('retry', {});
    expect(manager.state()).toMatchObject({locked: false, draftName: 'Saved draft', editing: true});
  } finally {await manager.close(); await rm(directory, {recursive: true, force: true});}
});

test('credential worker watchdog terminates an unresolved native-style request independently of its parent deadline', async () => {
  const {pathToFileURL} = await import('node:url');
  const directory = await mkdtemp('/tmp/zhx-worker-watchdog-');
  const moduleUrl = pathToFileURL(process.env.ZHX_APPLICATION_TEST_ENTRY ?? process.cwd() + '/packages/core/src/application/credential-process.ts').href;
  const entry = directory + '/watchdog.mjs';
  await writeFile(entry, `import {runCredentialWorker} from ${JSON.stringify(moduleUrl)};
void runCredentialWorker(async () => ({read: async () => {setInterval(() => {}, 1000); return await new Promise(() => {});}, write: async () => {}}));`);
  const started = Date.now();
  const child = Bun.spawn([process.env.ZHX_APPLICATION_TEST_ENTRY ? 'node' : process.execPath, entry], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
  const fallback = setTimeout(() => child.kill('SIGKILL'), 16000);
  try {
    child.stdin.write(JSON.stringify({operation: 'read', account: 'a'.repeat(64)})); child.stdin.end();
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(Date.now() - started).toBeGreaterThanOrEqual(11000);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(await new Response(child.stdout).text()).toBe('');
  } finally {clearTimeout(fallback); child.kill(); await rm(directory, {recursive: true, force: true});}
}, 20000);
