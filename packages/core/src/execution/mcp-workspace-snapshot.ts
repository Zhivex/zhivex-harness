import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectSnapshotInventory, readSnapshotFile } from './execution-environment.js';
import type { Workspace } from '../workspace/workspace.js';
import { readRegularFileNoFollow } from '../workspace/file-security.js';

export interface McpWorkspaceSnapshot {
  readonly digest: string;
  readonly workspace: string;
  readonly files: number;
  readonly bytes: number;
}
type SnapshotEntry = { path: string; digest: string; mode: number; bytes: number };
type Snapshot = { root: string; directory: string; entries: SnapshotEntry[]; used: boolean };
const snapshots = new WeakMap<McpWorkspaceSnapshot, Snapshot>();
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const safePath = (value: string) => value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

/** Host-only snapshot preparation. No container, secrets, commands or model input. */
export async function prepareMcpWorkspaceSnapshot(workspace: Workspace, maxWorkspaceBytes: number): Promise<McpWorkspaceSnapshot> {
  if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1024 || maxWorkspaceBytes > 512 * 1024 * 1024) {
    throw new Error('Invalid MCP snapshot byte limit.');
  }
  const root = await mkdtemp(path.join(tmpdir(), 'zhx-mcp-snapshot-'));
  await chmod(root, 0o700);
  const directory = path.join(root, 'workspace');
  try {
    const inventory = await collectSnapshotInventory(workspace, maxWorkspaceBytes, undefined, 20_000);
    const entries = [...inventory.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    await mkdir(directory, { mode: 0o700 });
    for (const expected of entries) {
      if (!safePath(expected.path)) throw new Error('Invalid MCP snapshot path.');
      // Shared descriptor-bound inventory and copy checks reject source replacement,
      // symlink ancestors, hardlinks, partial reads and byte/mode drift.
      const file = await readSnapshotFile(workspace, expected, undefined, true);
      const target = path.join(directory, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.contents, { flag: 'wx', mode: 0o400 });
    }
    const value: McpWorkspaceSnapshot = Object.freeze({
      digest: hash(JSON.stringify({ version: 1, entries })),
      workspace: hash(workspace.root), files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0)
    });
    snapshots.set(value, { root, directory, entries, used: false });
    return value;
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new Error('MCP workspace snapshot preparation failed.');
  }
}

/** Single-use, identity-bound handoff to the trusted OCI volume seeder. */
export async function consumeMcpWorkspaceSnapshot(snapshot: McpWorkspaceSnapshot, expected: {
  snapshotDigest: string; workspace: string; maxWorkspaceBytes: number;
}, seed: (files: AsyncIterable<{ path: string; contents: Uint8Array; executable: boolean }>) => Promise<void>): Promise<void> {
  const record = snapshots.get(snapshot);
  if (!record || record.used) throw new Error('Unknown or consumed MCP workspace snapshot.');
  record.used = true;
  try {
    if (snapshot.digest !== expected.snapshotDigest || snapshot.workspace !== expected.workspace || snapshot.bytes > expected.maxWorkspaceBytes) {
      throw new Error('MCP workspace snapshot identity changed.');
    }
    // A seeder must consume every file. Private paths are never exposed to callers
    // or copied via an unverified recursive docker cp walk.
    let delivered = 0;
    async function* files() {
      for (const entry of record!.entries) {
        const file = await readRegularFileNoFollow(path.join(record!.directory, ...entry.path.split('/')), {
          label: 'MCP snapshot file', maxBytes: entry.bytes, requireSingleLink: true
        });
        if (file.contents.byteLength !== entry.bytes || hash(file.contents) !== entry.digest) throw new Error('MCP private snapshot changed.');
        delivered++;
        yield { path: entry.path, contents: new Uint8Array(file.contents), executable: (entry.mode & 0o111) !== 0 };
      }
    }
    await seed(files());
    if (delivered !== record.entries.length) throw new Error('MCP snapshot was not fully seeded.');
  } catch {
    throw new Error('MCP workspace snapshot handoff failed.');
  } finally {
    await rm(record.root, { recursive: true, force: true });
    snapshots.delete(snapshot);
  }
}

export async function discardMcpWorkspaceSnapshot(snapshot: McpWorkspaceSnapshot): Promise<void> {
  const record = snapshots.get(snapshot);
  if (!record) return;
  if (record.used) throw new Error('MCP workspace snapshot handoff is active.');
  record.used = true;
  try { await rm(record.root, { recursive: true, force: true }); }
  finally { snapshots.delete(snapshot); }
}
