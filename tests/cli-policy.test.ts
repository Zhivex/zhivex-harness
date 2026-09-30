import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness } from '../src/runtime/harness.js';
import { inspectHarnessPolicy } from '../src/runtime/policy-inspection.js';
import { startHarnessLocalService } from '../src/client/local-service.js';
import { parseCliArgs } from '../src/cli/arguments.js';
import { parseCliJsonDocument, parseCliJsonLineDocument } from '../src/client/json-contracts.js';
const cli = path.resolve(import.meta.dir, '../src/cli.ts');
const run = async (root: string, args: string[]) => {
  const child = Bun.spawn([process.execPath, '--preload', path.join(root, 'no-network.mjs'), cli, ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, OPENAI_API_KEY: 'fixture-only', CONSOLE_FIXTURE_REQUESTS: path.join(root,'requests.jsonl'), ZHIVEX_HARNESS_CREDENTIAL_STORE: 'disabled' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); if (code) throw new Error(stderr);
  return stdout;
};
test('policy parser accepts local settings but service clients cannot override host policy', () => {
  expect(parseCliArgs(['policy', '--tool-policy', '/operator.json', '--json'])).toMatchObject({ command: 'policy', toolPolicyFile: '/operator.json', json: true });
  expect(() => parseCliArgs(['policy', '--service', '/credentials.json', '--tool-policy', '/operator.json'])).toThrow('runtime configuration belongs');
  expect(() => parseCliArgs(['policy', '--yes'])).toThrow();
});
test('standalone policy CLI is noninteractive JSON and performs no provider request', async () => {
  const root = await mkdtemp('/tmp/har-policy-cli-');
  try {
    await writeFile(path.join(root, 'no-network.mjs'), "globalThis.fetch=()=>{throw new Error('UNEXPECTED_PROVIDER_REQUEST')};");
    const locator = ['--workspace', root, '--state-dir', path.join(root, 'state')];
    const result = parseCliJsonDocument(JSON.parse(await run(root, ['policy', ...locator, '--json'])));
    expect(result).toMatchObject({ kind: 'policy-inspection', schemaVersion: 1, source: 'baseline', execution: { activeBackend: 'none', evidence: 'configuration-only' } });
    const runs = JSON.parse(await run(root, ['runs', 'list', ...locator, '--json']));
    expect(runs.runs).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('service policy CLI matches library output and creates no session', async () => {
  const root = await mkdtemp('/tmp/har-policy-cli-service-');
  const harness = await createHarness({ workspace: root, subagentProfiles: [], modelInstance: createMockLanguageModel() });
  const service = await startHarnessLocalService(harness, { directory: path.join(root, 'socket') });
  try {
    // HTTP over the service socket uses node:http; fetch remains prohibited for models.
    await writeFile(path.join(root, 'no-network.mjs'), "globalThis.fetch=()=>{throw new Error('UNEXPECTED_PROVIDER_REQUEST')};");
    expect(JSON.parse(await run(root, ['policy', '--service', service.credentialsPath, '--json']))).toEqual(inspectHarnessPolicy(harness));
    const sessions = JSON.parse(await run(root, ['sessions', 'list', '--service', service.credentialsPath, '--json']));
    expect(sessions.sessions).toHaveLength(0);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});


test('local run JSON includes bounded policy decisions for an unexecuted approval', async () => {
  const root = await mkdtemp('/tmp/har-policy-cli-run-');
  try {
    await writeFile(path.join(root,'no-network.mjs'), await readFile(path.resolve(import.meta.dir,'fixtures/console-fetch.mjs'),'utf8'));
    const result = JSON.parse(await run(root,['run','EDIT_FIXTURE','--workspace',root,'--state-dir',path.join(root,'state'),'--json']));
    expect(result.status).toBe('waiting_approval');
    expect(result.policyEvidence).toMatchObject({schemaVersion:1,scope:'invocation',truncated:false,events:[{phase:'approval-request',decision:'ask_user'}]});
    expect(await Bun.file(path.join(root,'result.txt')).exists()).toBe(false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('resume retains the pending policy explanation even when the action is denied', async () => {
  const root = await mkdtemp('/tmp/har-policy-cli-resume-');
  try {
    await writeFile(path.join(root,'no-network.mjs'), await readFile(path.resolve(import.meta.dir,'fixtures/console-fetch.mjs'),'utf8'));
    const locator = ['--workspace',root,'--state-dir',path.join(root,'state')];
    const pending = JSON.parse(await run(root,['run','EDIT_FIXTURE',...locator,'--json']));
    expect(pending.status).toBe('waiting_approval');
    const result = JSON.parse(await run(root,['resume',pending.runId,'--deny',...locator,'--json']));
    expect(result.policyEvidence.events).toContainEqual(expect.objectContaining({phase:'approval-request',toolName:'apply_reviewed_edits',decision:'ask_user'}));
    expect(result.policyEvidence.events.some((event: {phase:string}) => event.phase === 'tool-entry')).toBe(false);
    expect(await Bun.file(path.join(root,'result.txt')).exists()).toBe(false);
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('local JSONL emits policy decisions with valid shared sequence numbers', async () => {
  const root = await mkdtemp('/tmp/har-policy-cli-jsonl-');
  try {
    await writeFile(path.join(root,'no-network.mjs'), await readFile(path.resolve(import.meta.dir,'fixtures/console-fetch.mjs'),'utf8'));
    const output = await run(root,['run','EDIT_FIXTURE','--workspace',root,'--state-dir',path.join(root,'state'),'--jsonl']);
    const records = output.trim().split('\n').map(line => parseCliJsonLineDocument(line));
    expect(records.filter(row => row.kind === 'run-event' && row.type === 'policy-decision')).toHaveLength(1);
    expect(records.map(row => row.sequence)).toEqual(records.map((_,index) => index+1));
    expect(records.at(-1)).toMatchObject({kind:'run-stream-result',status:'waiting_approval'});
  } finally { await rm(root,{recursive:true,force:true}); }
});
