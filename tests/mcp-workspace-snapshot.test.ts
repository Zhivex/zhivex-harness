import { expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { prepareMcpWorkspaceSnapshot, consumeMcpWorkspaceSnapshot, discardMcpWorkspaceSnapshot, type McpWorkspaceSnapshot } from '../src/execution/mcp-workspace-snapshot.js';

async function fixture(run: (root: string, workspace: Workspace) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-snapshot-test-'));
  try { await writeFile(path.join(root, 'data.txt'), 'original'); await run(root, await Workspace.open(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const binding = (snapshot: McpWorkspaceSnapshot) => ({ snapshotDigest: snapshot.digest, workspace: snapshot.workspace, maxWorkspaceBytes: 4096 });
const collect = async (snapshot: McpWorkspaceSnapshot) => {
  const entries: { path: string; value: string; executable: boolean }[] = [];
  await consumeMcpWorkspaceSnapshot(snapshot, binding(snapshot), async files => {
    for await (const file of files) entries.push({ path: file.path, value: new TextDecoder().decode(file.contents), executable: file.executable });
  });
  return entries;
};

test('snapshot freezes reviewed bytes and preserves executable intent without exposing host paths', async () => fixture(async (root, workspace) => {
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts', 'run.sh'), '#!/bin/sh\n');
  await chmod(path.join(root, 'scripts', 'run.sh'), 0o755);
  const snapshot = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain(root);
  await writeFile(path.join(root, 'data.txt'), 'changed after review');
  expect(await collect(snapshot)).toEqual([
    { path: 'data.txt', value: 'original', executable: false },
    { path: 'scripts/run.sh', value: '#!/bin/sh\n', executable: true }
  ]);
  await expect(collect(snapshot)).rejects.toThrow('consumed');
}));

test('snapshot excludes workspace secrets, ignored files and symlink targets', async () => fixture(async (root, workspace) => {
  await writeFile(path.join(root, '.env'), 'private-secret');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'private'), 'excluded');
  await symlink(path.join(root, '.env'), path.join(root, 'read-me'));
  const snapshot = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  expect(await collect(snapshot)).toEqual([{ path: 'data.txt', value: 'original', executable: false }]);
}));

test('digest is repeatable and changes with content and mode', async () => fixture(async (root, workspace) => {
  const first = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  const same = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  expect(first.digest).toBe(same.digest);
  await chmod(path.join(root, 'data.txt'), 0o755);
  const mode = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  expect(mode.digest).not.toBe(first.digest);
  await writeFile(path.join(root, 'data.txt'), 'different');
  const content = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  expect(content.digest).not.toBe(mode.digest);
  await Promise.all([first, same, mode, content].map(discardMcpWorkspaceSnapshot));
}));

test('serialized or forged snapshot cannot reach seeder', async () => fixture(async (_root, workspace) => {
  const snapshot = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  let seeds = 0;
  await expect(consumeMcpWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)), binding(snapshot), async () => { seeds++; }))
    .rejects.toThrow('Unknown');
  expect(seeds).toBe(0);
  await discardMcpWorkspaceSnapshot(snapshot);
}));

for (const drift of ['workspace', 'snapshotDigest', 'maxWorkspaceBytes'] as const) {
  test(`snapshot rejects ${drift} mismatch and burns its capability`, async () => fixture(async (_root, workspace) => {
    const snapshot = await prepareMcpWorkspaceSnapshot(workspace, 4096);
    let seeds = 0;
    const expected = binding(snapshot);
    if (drift === 'maxWorkspaceBytes') expected.maxWorkspaceBytes = 1;
    else expected[drift] = `sha256:${'b'.repeat(64)}`;
    await expect(consumeMcpWorkspaceSnapshot(snapshot, expected, async () => { seeds++; })).rejects.toThrow('handoff failed');
    expect(seeds).toBe(0);
    await expect(collect(snapshot)).rejects.toThrow('consumed');
  }));
}

test('partial or failed seeding cannot report success or retry', async () => fixture(async (_root, workspace) => {
  const partial = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  await expect(consumeMcpWorkspaceSnapshot(partial, binding(partial), async () => {})).rejects.toThrow('handoff failed');
  const failed = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  await expect(consumeMcpWorkspaceSnapshot(failed, binding(failed), async () => { throw new Error('secret-canary'); }))
    .rejects.toThrow('MCP workspace snapshot handoff failed.');
  await expect(collect(failed)).rejects.toThrow('consumed');
}));

test('oversized and hardlinked sources are rejected', async () => fixture(async (root, workspace) => {
  await writeFile(path.join(root, 'large'), 'x'.repeat(2048));
  await expect(prepareMcpWorkspaceSnapshot(workspace, 1024)).rejects.toThrow('preparation failed');
  await rm(path.join(root, 'large'));
  await link(path.join(root, 'data.txt'), path.join(root, 'alias'));
  await expect(prepareMcpWorkspaceSnapshot(workspace, 4096)).rejects.toThrow('preparation failed');
}));

test('discard is idempotent and prevents handoff', async () => fixture(async (_root, workspace) => {
  const snapshot = await prepareMcpWorkspaceSnapshot(workspace, 4096);
  await discardMcpWorkspaceSnapshot(snapshot); await discardMcpWorkspaceSnapshot(snapshot);
  await expect(collect(snapshot)).rejects.toThrow('Unknown');
}));
