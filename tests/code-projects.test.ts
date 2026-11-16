import { execFileSync } from 'node:child_process';
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, realpath, symlink, writeFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createCodeProjects } from '../packages/core/src/application/code/projects.js';
import { connectApplication } from '../packages/core/src/application/client.js';

test('Code project registry isolates conversations, deduplicates canonical folders and restores without a manual service', async () => {
  const root = await mkdtemp('/tmp/code-projects-');
  await mkdir(root + '/a'); await mkdir(root + '/b'); await symlink(root + '/a', root + '/alias');
  for (const name of ['a', 'b']) execFileSync('git', ['-C', root + '/' + name, 'init', '-q']);
  let saved: unknown, failSave = false;
  const options = { directory: root + '/sockets', read: () => saved, save: (value: unknown) => { if (failSave) throw new Error('SAVE_FAILED'); saved = structuredClone(value); },
    connection: (id: string) => { if (id !== 'connection') throw new Error('CODE_CONNECTION_NOT_FOUND'); return { engine: {modelInstance: createMockLanguageModel(), storeBackend: 'sqlite' as const, subagentProfiles: []} }; } };
  let projects = createCodeProjects(options);
  try {
    await writeFile(root + '/a/AGENTS.md', 'Use Bun. Private body stays in the host.');
    await projects.open(root + '/a', 'connection');
    const context = projects.currentHost()!.context();
    expect(context.sources[0]?.path).toBe('AGENTS.md');
    expect(JSON.stringify(context)).not.toContain('Private body');
    await writeFile(root + '/a/AGENTS.md', 'Changed after host startup.');
    expect(projects.currentHost()!.context().fingerprint).toBe(context.fingerprint);
    const first = projects.state().active;
    let client = await connectApplication(projects.currentHost()!.credentialsPath);
    const created = await client.command({ method: 'session.create', title: 'Project A', idempotencyKey: 'session' });
    expect(created.ok).toBe(true);
    await projects.open(root + '/alias', 'connection'); expect(projects.state().projects).toHaveLength(1);
    expect(projects.state().projects[0]?.workspace).toBe(await realpath(root + '/a'));
    failSave = true; await expect(projects.open(root + '/b', 'connection')).rejects.toThrow('SAVE_FAILED'); failSave = false;
    expect(projects.state().active).toBe(first); expect((await client.command({method: 'session.list'})).ok).toBe(true);
    await expect(projects.open(root + '/b', 'missing')).rejects.toThrow('CODE_CONNECTION_NOT_FOUND');
    await projects.open(root + '/b', 'connection');
    expect(projects.currentHost()!.context().sources).toEqual([]);
    client = await connectApplication(projects.currentHost()!.credentialsPath);
    expect(await client.command({method: 'session.list'})).toMatchObject({ok: true, data: {sessions: []}});
    await projects.select(first!);
    expect(projects.currentHost()!.context().fingerprint).not.toBe(context.fingerprint);
    await projects.close(); projects = createCodeProjects(options); await projects.restore();
    client = await connectApplication(projects.currentHost()!.credentialsPath);
    const listed = await client.command({method: 'session.list'});
    expect(listed).toMatchObject({ok: true, data: {sessions: [{title: 'Project A'}]}});
    expect(projects.state().projects).toHaveLength(2);
    await expect(projects.select('unknown')).rejects.toThrow('CODE_PROJECT_NOT_FOUND');
  } finally { await projects.close(); await rm(root, {recursive: true, force: true}); }
});

test('a missing registered project is reported without creating a replacement folder', async () => {
  const root = await mkdtemp('/tmp/code-missing-');
  const projects = createCodeProjects({directory: root + '/sockets', read: () => ({version: 1, active: 'a'.repeat(24), projects: [{id: 'a'.repeat(24), workspace: root + '/missing', label: 'Missing', connectionId: 'c'}]}), save: () => {}, connection: () => { throw new Error('SHOULD_NOT_CONNECT'); }});
  try { await projects.restore(); expect(projects.state()).toMatchObject({ready: false, error: 'CODE_PROJECT_UNAVAILABLE'}); }
  finally { await projects.close(); await rm(root, {recursive: true, force: true}); }
});

test('invalid Git selections preserve the current host; empty repositories and linked worktrees are accepted', async () => {
  const root = await mkdtemp('/tmp/code-repository-');
  for (const name of ['repo', 'plain', 'bare']) await mkdir(root + '/' + name);
  const git = (directory: string, args: string[]) => execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {stdio: 'pipe'});
  git(root + '/repo', ['init', '-q']); git(root + '/bare', ['init', '--bare', '-q']);
  await mkdir(root + '/repo/subfolder');
  let saved: unknown;
  const options = {directory: root + '/sockets', read: () => saved, save: (value: unknown) => {saved = structuredClone(value);}, connection: () => ({engine: {modelInstance: createMockLanguageModel(), subagentProfiles: []}})};
  let projects = createCodeProjects(options);
  try {
    await projects.open(root + '/repo', 'fixture');
    const initial = projects.state();
    const client = await connectApplication(projects.currentHost()!.credentialsPath);
    for (const [directory, code] of [['plain', 'CODE_GIT_REQUIRED'], ['bare', 'CODE_GIT_REQUIRED'], ['repo/subfolder', 'CODE_GIT_ROOT_REQUIRED']] as const) {
      await expect(projects.open(root + '/' + directory, 'fixture')).rejects.toThrow(code);
      expect(projects.state()).toEqual(initial);
      expect((await client.command({method: 'session.list'})).ok).toBe(true);
    }
    // A committed repository can also supply a linked checkout with a .git file.
    git(root + '/repo', ['commit', '--allow-empty', '-qm', 'Initial']);
    git(root + '/repo', ['worktree', 'add', '-qb', 'feat/linked', root + '/linked']);
    await projects.open(root + '/linked', 'fixture');
    expect(projects.state().projects).toHaveLength(2);
    expect(projects.state().projects.find(project => project.id === projects.state().active)?.workspace).toBe(await realpath(root + '/linked'));
    // Persisted selections are validated again on startup; do not recreate Git metadata.
    await projects.close();
    await rm(root + '/linked/.git');
    projects = createCodeProjects(options);
    expect(await projects.restore()).toMatchObject({ready: false, error: 'CODE_GIT_REQUIRED'});
    expect(projects.state().projects).toHaveLength(2);
  } finally {await projects.close(); await rm(root, {recursive: true, force: true});}
});
