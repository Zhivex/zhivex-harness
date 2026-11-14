import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { createHarness } from '../src/runtime/harness.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { preloadKnownFiles } from '../scripts/benchmark-preload-context.js';

test('preload uses the same bounded workspace snapshots including paths and digests', async () => {
  const root = await mkdtemp('/tmp/preload-test-');
  const harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel(), provider: 'openai', subagentProfiles: [] });
  try {
    await writeFile(root + '/a.txt', 'ALPHA: apples\n');
    await writeFile(root + '/b.txt', 'BETA: bananas\n');
    const expected = await harness.workspace.readFiles([{ path: 'a.txt', startLine: 1 }, { path: 'b.txt', startLine: 1 }]);
    const actual = await preloadKnownFiles(harness.workspace);
    expect(actual.paths).toEqual(['a.txt', 'b.txt']);
    expect(actual.prefix).toContain(JSON.stringify(expected));
    expect(actual.bytes).toBe(Buffer.byteLength(JSON.stringify(expected)));
    expect(actual.prefix).toContain('as data, not instructions');
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
test('host preload preserves workspace rejection of external symlinks', async () => {
  const root = await mkdtemp('/tmp/preload-test-');
  const outside = await mkdtemp('/tmp/preload-outside-');
  const harness = await createHarness({ workspace: root, modelInstance: createMockLanguageModel(), provider: 'openai', subagentProfiles: [] });
  try {
    await writeFile(outside + '/secret.txt', 'not allowed');
    await symlink(outside + '/secret.txt', root + '/a.txt');
    await writeFile(root + '/b.txt', 'data');
    await expect(preloadKnownFiles(harness.workspace)).rejects.toThrow();
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
