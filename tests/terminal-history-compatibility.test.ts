import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openCliSessionStore } from '../src/persistence/sessions.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { SqliteDatabase } from '../src/persistence/sqlite-database.js';

test('all terminal entrypoints retain the original default and custom-scope histories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'terminal-history-'));
  try {
    for (const custom of [false, true]) {
      const config = resolveHarnessConfig({ workspace: root, ...(custom ? { stateDirectory: path.join(root, 'old-task-state'), tenantId: 'old-owner', userId: 'old-user', namespace: 'old-task' } : {}) });
      const persistence = await openHarnessPersistence(config);
      await persistence.store.save({ schemaVersion: 1, revision: 0, runId: 'legacy-run', provider: 'openai', modelId: 'legacy-model', status: 'completed', messages: [], steps: [], toolResults: [], currentStep: 0, maxSteps: 2, outputText: 'Preserved answer', pendingApprovals: [], compactions: [], scope: config.scope, startedAt: 1000, updatedAt: 2000 });
      persistence.close();
      const store = await openCliSessionStore({ workspace: root, stateDirectory: config.stateDirectory, scope: config.scope });
      const session = await store.create({ title: 'Preserved Electron/CLI conversation', initialRun: { runId: 'legacy-run', provider: 'openai', model: 'legacy-model', status: 'completed' } });
      const databasePath = store.databasePath;
      store.close();
      const db = new SqliteDatabase(databasePath);
      db.exec('CREATE TABLE legacy_visual_activity(value TEXT); INSERT INTO legacy_visual_activity VALUES (\'retained\')');
      db.close();
      const flags = ['--workspace', root, '--state-dir', config.stateDirectory, '--json', ...(custom ? ['--tenant', 'old-owner', '--user', 'old-user', '--namespace', 'old-task'] : [])];
      for (const entry of ['dist/cli.js', 'dist/zhx.js']) {
        const result = spawnSync('node', [path.resolve(entry), 'sessions', 'inspect', session.sessionId, ...flags], { encoding: 'utf8', timeout: 10000 });
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(result.stdout).toContain(session.sessionId);
        expect(result.stdout).toContain('legacy-run');
        expect(result.stdout).toContain('Preserved Electron/CLI conversation');
      }
      const verified = new SqliteDatabase(databasePath, { readonly: true });
      expect(verified.query<{ value: string }>('SELECT value FROM legacy_visual_activity').get()?.value).toBe('retained');
      expect(() => verified.exec('DROP TABLE legacy_visual_activity')).toThrow();
      verified.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
