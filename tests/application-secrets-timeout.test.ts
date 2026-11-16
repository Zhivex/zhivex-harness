import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {withBoundedSecretReads} from '../packages/core/src/application/assistant/managed/secrets.js';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';

test('credential read deadline neither overlaps calls nor turns a late read into a write', async () => {
  let finish!: (value: string) => void, reads = 0, writes = 0;
  const store = withBoundedSecretReads({read: () => {reads++; return new Promise(resolve => {finish = resolve;});}, async write() {writes++;}}, 15);
  await expect(store.read()).rejects.toThrow('SETUP_KEYCHAIN_UNAVAILABLE');
  await expect(store.read()).rejects.toThrow('SETUP_KEYCHAIN_BUSY');
  await expect(store.write('do not overwrite')).rejects.toThrow('SETUP_KEYCHAIN_BUSY');
  expect(reads).toBe(1); expect(writes).toBe(0);
  finish('late saved profile'); await Promise.resolve(); await Promise.resolve();
  const retry = store.read(); await Promise.resolve(); finish('explicitly reread profile');
  expect(await retry).toBe('explicitly reread profile'); expect(reads).toBe(2);
});

test('credential errors are preserved and successful absence remains distinct', async () => {
  expect(await withBoundedSecretReads({async read() {return null;}, async write() {}}).read()).toBeNull();
  await expect(withBoundedSecretReads({async read() {throw new Error('LOCKED');}, async write() {}}).read()).rejects.toThrow('LOCKED');
});

test('coordinator becomes responsive after hung credential read, blocks empty projections and requires explicit retry', async () => {
  const directory = await mkdtemp('/tmp/zhx-secret-deadline-');
  let finish!: (value: null) => void, reads = 0, writes = 0;
  const start = Date.now();
  const owner = await startApplicationCoordinator(directory, {secrets: {
    read: () => {reads++; return reads === 1 ? new Promise(resolve => {finish = resolve;}) : Promise.resolve(null);},
    async write() {writes++;},
  }});
  try {
    expect(Date.now() - start).toBeLessThan(15000);
    const client = await connectCoordinator(directory);
    expect((await client.state()).state).toMatchObject({locked: true, error: 'SETUP_KEYCHAIN_UNAVAILABLE', ready: false});
    const cli = async (args: string[]) => {
      const child = Bun.spawn([...(process.env.ZHX_CLI_TEST_ENTRY ? ['node', process.env.ZHX_CLI_TEST_ENTRY] : [process.execPath, '--no-env-file', 'packages/core/src/cli.ts']), ...args, '--application-directory', directory, '--json'], {stdout: 'pipe', stderr: 'pipe'});
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return {code, stdout, stderr};
    };
    const status = await cli(['application', 'status']); expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({status: 'running', assistantLocked: true, assistantError: 'SETUP_KEYCHAIN_UNAVAILABLE'});
    const list = await cli(['agents', 'list']); expect(list.code).toBe(2); expect(list.stdout).toBe('');

    for (const resource of ['agents', 'connections']) await expect(client.call('management', {resource, action: 'list', args: []})).rejects.toThrow('SETUP_KEYCHAIN_UNAVAILABLE');
    await expect(client.call('action', {name: 'begin', value: {}})).rejects.toThrow('SETUP_KEYCHAIN_UNAVAILABLE');
    await expect(client.call('action', {name: 'retry', value: {}})).rejects.toThrow('SETUP_KEYCHAIN_BUSY');
    expect(reads).toBe(1); expect(writes).toBe(0);
    finish(null); await Promise.resolve(); await Promise.resolve();
    expect((await client.state()).state.locked).toBe(true);
    await client.call('action', {name: 'retry', value: {}});
    expect((await client.state()).state.locked).toBe(false);
    expect(await client.call('management', {resource: 'agents', action: 'list', args: []})).toMatchObject({agents: [], draft: null});
    expect(reads).toBe(2); expect(writes).toBe(0);
  } finally {await owner.close(); await rm(directory, {recursive: true, force: true});}
}, 20000);
