import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {startApplicationCoordinator} from '../packages/core/src/application/coordinator.js';
import {connectCoordinator} from '../packages/core/src/application/coordinator-client.js';
import {parseCliArgs} from '../packages/core/src/cli/arguments.js';
import {parseCliJsonDocument} from '../packages/core/src/client/json-contracts.js';

test('projects context rejects invalid arguments before host discovery', () => {
  expect(parseCliArgs(['projects', 'context'])).toMatchObject({managementAction: 'context', managementArgs: []});
  for (const extra of [['another-project'], ['--area','code'], ['--service','file'], ['--jsonl']]) expect(() => parseCliArgs(['projects', 'context', ...extra])).toThrow();
});

test('CLI reads the same loaded Code bundle and refuses absent or stale project scope', async () => {
  const directory = await mkdtemp('/tmp/zhx-context-cli-'); let stored: string | null = null;
  for (const name of ['a', 'b']) {await mkdir(directory + '/' + name); execFileSync('git', ['-C', directory + '/' + name, 'init', '-q']);}
  await writeFile(directory + '/a/AGENTS.md', 'Private instructions: use Bun.');
  const owner = await startApplicationCoordinator(directory, {secrets: {async read() {return stored;}, async write(value) {stored = value;}}, validateProvider: async () => {}});
  const client = await connectCoordinator(directory);
  const cli = async (expected = 0) => {
    const child = Bun.spawn([...(process.env.ZHX_CLI_TEST_ENTRY ? ['node', process.env.ZHX_CLI_TEST_ENTRY] : [process.execPath, '--no-env-file', 'packages/core/src/cli.ts']), 'projects', 'context', '--application-directory', directory, '--json'], {stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(expected); expect(stdout + stderr).not.toContain('context-fixture-secret');
    const result = JSON.parse(code ? stderr : stdout); if (!code) parseCliJsonDocument(result); return result;
  };
  try {
    expect(await cli(2)).toMatchObject({kind: 'error', error: {code: 'CONFIG_INVALID'}});
    await client.call('action', {name: 'begin', value: {}});
    await client.call('action', {name: 'provider', value: {baseURL: 'https://example.invalid/v1', model: 'fixture-model', apiKey: 'context-fixture-secret'}});
    const connectionId = (await client.state()).state.connections[0]!.id;
    await client.call('code-open', {workspace: directory + '/a', connectionId});
    const a = await cli();
    expect(a).toMatchObject({kind: 'application-code-context', enabled: true, model: 'fixture-model', sources: [{path: 'AGENTS.md'}]});
    expect(JSON.stringify(a)).not.toContain('Private instructions');
    const {kind, projectId, ...context} = a;
    expect(await client.call('code-tools', {action: 'context', value: {projectId}})).toEqual(context);
    await writeFile(directory + '/a/AGENTS.md', 'Changed instructions.');
    expect((await cli()).fingerprint).toBe(a.fingerprint);
    await client.call('code-open', {workspace: directory + '/b', connectionId});
    expect((await cli()).sources).toEqual([]);
    await expect(client.call('code-tools', {action: 'context', value: {projectId}})).rejects.toThrow('APPLICATION_SCOPE_CHANGED');
    await expect(client.call('code-tools', {action: 'context', value: {projectId, path: '/tmp/arbitrary'}})).rejects.toThrow();
  } finally {await owner.close(); await rm(directory, {recursive: true, force: true});}
}, 30000);
