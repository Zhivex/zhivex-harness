import { expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadHarnessToolPolicyFile } from '../src/runtime/tool-policy-file.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { parseCliArgs } from '../src/cli/arguments.js';
import { harnessClientCommandSchema } from '../src/client/protocol.js';

const policy = { schemaVersion: 1, rules: [{ id: 'deny-shell', tools: ['run_command'], decision: 'deny', reason: 'Operator restriction' }] };
const fixture = async (body: (root: string, filename: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trusted-policy-'));
  const root = path.join(directory, 'workspace');
  const filename = path.join(directory, 'policy.json');
  await mkdir(root);
  await writeFile(filename, JSON.stringify(policy), { mode: 0o600 });
  try { await body(root, filename); } finally { await rm(directory, { recursive: true, force: true }); }
};

test('explicit private policy loads a detached canonical policy and preserves restrictive decisions', () => fixture(async (root, filename) => {
  const loaded = await loadHarnessToolPolicyFile(filename, root);
  expect(loaded.evaluate({ toolName: 'run_command' }).decision).toBe('deny');
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, rules: [] }));
  expect(loaded.evaluate({ toolName: 'run_command' }).decision).toBe('deny');
  expect((await loadHarnessToolPolicyFile(filename, root)).digest).not.toBe(loaded.digest);
}));

test('rejects relative, repository, permissive, symlink and hardlink policy inputs', () => fixture(async (root, filename) => {
  await expect(loadHarnessToolPolicyFile('policy.json', root)).rejects.toThrow('absolute');
  const repositoryPolicy = path.join(root, 'policy.json');
  await writeFile(repositoryPolicy, JSON.stringify(policy), { mode: 0o600 });
  await expect(loadHarnessToolPolicyFile(repositoryPolicy, root)).rejects.toThrow('outside');
  await chmod(filename, 0o644);
  await expect(loadHarnessToolPolicyFile(filename, root)).rejects.toThrow('private');
  await chmod(filename, 0o600);
  const alias = `${filename}.alias`;
  await symlink(filename, alias);
  await expect(loadHarnessToolPolicyFile(alias, root)).rejects.toThrow();
  await link(filename, `${filename}.hardlink`);
  await expect(loadHarnessToolPolicyFile(filename, root)).rejects.toThrow();
}));

test('rejects unknown versions, unknown fields, invalid UTF-8 and oversized policy files', () => fixture(async (root, filename) => {
  for (const input of [{ ...policy, schemaVersion: 2 }, { ...policy, relaxPermissions: true }, { ...policy, rules: [{ ...policy.rules[0], decision: 'auto' }] }]) {
    await writeFile(filename, JSON.stringify(input));
    await expect(loadHarnessToolPolicyFile(filename, root)).rejects.toThrow();
  }
  await writeFile(filename, Buffer.from([0xff, 0xfe]));
  await expect(loadHarnessToolPolicyFile(filename, root)).rejects.toThrow();
  await writeFile(filename, ' '.repeat(128 * 1024 + 1));
  await expect(loadHarnessToolPolicyFile(filename, root)).rejects.toThrow('limit');
}));

test('rejects repository siblings of a nested workspace and symlink ancestors', () => fixture(async (root, filename) => {
  await mkdir(path.join(root, '.git'));
  const nested = path.join(root, 'packages', 'app');
  await mkdir(nested, { recursive: true });
  const sibling = path.join(root, 'policy.json');
  await writeFile(sibling, JSON.stringify(policy), { mode: 0o600 });
  await expect(loadHarnessToolPolicyFile(sibling, nested)).rejects.toThrow('outside');
  const alias = path.join(path.dirname(filename), 'alias');
  await symlink(root, alias);
  await expect(loadHarnessToolPolicyFile(path.join(alias, 'policy.json'), nested)).rejects.toThrow();
}));

test('library loads policy before runtime use and changed file changes durable binding', () => fixture(async (root, filename) => {
  const input = { workspace: root, modelInstance: createMockLanguageModel(), store: createInMemoryAgentRunStore(), subagentProfiles: [] as [] };
  const readPolicy = { schemaVersion: 1, rules: [{ id: 'deny-read', tools: ['read_file'], decision: 'deny', reason: 'Private workspace' }] };
  await writeFile(filename, JSON.stringify(readPolicy));
  await writeFile(path.join(root, 'a.txt'), 'private fixture');
  await expect(createHarness({ ...input, toolPolicyFile: filename, toolPolicy: { schemaVersion: 1, rules: [] } })).rejects.toThrow('not both');
  const first = await createHarness({ ...input, toolPolicyFile: filename });
  try {
    const read = (first.agent.tools as Record<string, { execute(input: unknown): Promise<unknown> }>).read_file!;
    await expect(read.execute({ path: 'a.txt' })).rejects.toThrow('deny-read');
    const identical = await createHarness({ ...input, toolPolicyFile: filename });
    try { expect(identical.agent.harness?.fingerprint).toBe(first.agent.harness?.fingerprint); }
    finally { await identical.close(); }
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, rules: [] }));
    const changed = await createHarness({ ...input, toolPolicyFile: filename });
    try { expect(changed.agent.harness?.fingerprint).not.toBe(first.agent.harness?.fingerprint); }
    finally { await changed.close(); }
    await expect(read.execute({ path: 'a.txt' })).rejects.toThrow('deny-read');
  } finally { await first.close(); }
}));

test('CLI accepts host policy for construction/resume and service clients cannot supply authority', () => {
  for (const args of [['run', 'task'], ['chat'], ['review', 'review task'], ['resume', 'run-id', '--approve']]) {
    expect(parseCliArgs([...args, '--tool-policy', '/private/operator.json']).toolPolicyFile).toBe('/private/operator.json');
  }
  expect(() => parseCliArgs(['run', 'task', '--service', '/service.json', '--session', 'session', '--tool-policy', '/private/operator.json'])).toThrow('service host');
  const command = { method: 'run.start', projectId: 'project', sessionId: 'session', expectedRevision: 0, idempotencyKey: 'key', prompt: 'task' };
  for (const authority of [{ toolPolicyFile: '/private/operator.json' }, { toolPolicy: { schemaVersion: 1, rules: [] } }]) {
    expect(harnessClientCommandSchema.safeParse({ ...command, ...authority }).success).toBe(false);
  }
});

test('children retain policy and an incompatible restart rejects pending approval before writing', () => fixture(async (root, filename) => {
  const store = createInMemoryAgentRunStore();
  const configured = { workspace: root, store, toolPolicyFile: filename, subagentProfiles: ['explorer'] as ['explorer'] };
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, rules: [{ id: 'read-denied', tools: ['read_file'], decision: 'deny', reason: 'Host policy' }] }));
  const first = await createHarness({ ...configured, modelInstance: createMockLanguageModel({ streamEvents: [[
    { type: 'tool-call', toolCall: { id: 'create', name: 'apply_reviewed_edits', input: { changes: [{ path: 'created.txt', expectedDigest: null, content: 'new' }] } } },
    { type: 'finish', finishReason: 'tool-calls' }
  ]] }) });
  let pending: Awaited<ReturnType<typeof runHarness>>;
  let childFingerprint: string | undefined;
  try {
    const child = first.subagents.get('explorer')!;
    childFingerprint = child.harness?.fingerprint;
    const tools = child.tools as Record<string, { execute(input: unknown): Promise<unknown> }>;
    await expect(tools.read_file!.execute({ path: 'private.txt' })).rejects.toThrow('read-denied');
    pending = await runHarness(first, { prompt: 'create file' });
    expect(pending.status).toBe('waiting_approval');
  } finally { await first.close(); }
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, rules: [] }));
  const second = await createHarness({ ...configured, modelInstance: createMockLanguageModel() });
  try {
    expect(second.subagents.get('explorer')?.harness?.fingerprint).not.toBe(childFingerprint);
    await expect(runHarness(second, { state: pending!.state, approvals: pending!.state.pendingApprovals.map(approval => ({ provider: approval.provider, approvalRequestId: approval.id, approve: true })) })).rejects.toThrow(/harness|fingerprint|binding/i);
    expect(await Bun.file(path.join(root, 'created.txt')).exists()).toBe(false);
  } finally { await second.close(); }
}));
