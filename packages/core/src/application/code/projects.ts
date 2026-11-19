import type {CodeProjectState} from '../contracts.js';
export type {CodeProject, CodeProjectState} from '../contracts.js';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { openTaskWorktrees } from './worktrees.js';
import { startCodeHost } from './host.js';
import { connectApplication } from '../client.js';
import { inspectCodeWorkspace } from './repository.js';

const projectSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/), workspace: z.string().min(1), connectionId: z.string().min(1), label: z.string().min(1), isGitRepository: z.boolean().optional() }).strict();
const registrySchema = z.object({ version: z.literal(1), active: z.string().optional(), projects: z.array(projectSchema).max(100) }).strict();
type Host = Awaited<ReturnType<typeof startCodeHost>>;
/** Registry storage is owned/locked by the application manager. One Code project stays running alongside Assistant. */
export function createCodeProjects(options: {
  directory: string; read(): unknown; save(value: z.infer<typeof registrySchema>): void;
  connection(id: string): Pick<Parameters<typeof startCodeHost>[0], 'engine' | 'sensitiveValues'>;
}) {
  let registry = registrySchema.parse(options.read() ?? { version: 1, projects: [] });
  let host: Host | undefined, error: string | null = null, busy = false, closed = false;
  let worktreeRegistry: ReturnType<typeof openTaskWorktrees> | undefined;
  const tasks = () => worktreeRegistry ??= openTaskWorktrees(path.join(options.directory, 'worktrees'));
  const sourceProject = async () => {
    const current = registry.projects.find(value => value.id === registry.active);
    if (!current) throw new Error('CODE_PROJECT_NOT_FOUND');
    if (current.isGitRepository === false) throw new Error('CODE_GIT_REQUIRED');
    const task = (await tasks()).list().find(value => value.workspace === current.workspace);
    const source = task ? registry.projects.find(value => value.workspace === task.sourceWorkspace) : current;
    if (!source) throw new Error('CODE_PROJECT_NOT_FOUND');
    if (source.isGitRepository === false) throw new Error('CODE_GIT_REQUIRED');
    return source;
  };
  const sourceKey = (workspace: string) => `project_${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}`;
  let settled: Promise<void> = Promise.resolve();
  const state = (): CodeProjectState => ({ ...structuredClone(registry), ready: Boolean(host), error });
  const stop = async () => { if (host) { host.pauseAdmission(); await host.cancelActive(); await host.close(); host = undefined; } };
  const open = async (workspace: string, connectionId: string) => {
    if (busy || closed) throw new Error('CODE_BUSY'); busy = true;
    let finish!: () => void; settled = new Promise(resolve => { finish = resolve; });
    let previous = host;
    try {
      workspace = await realpath(workspace);
      if (!(await stat(workspace)).isDirectory()) throw new Error('CODE_WORKSPACE_INVALID');
      const inspected = await inspectCodeWorkspace(workspace);
      const id = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
      const current = registry.projects.find(project => project.id === id);
      if (current && current.isGitRepository !== false && !inspected.isGitRepository) throw new Error('CODE_GIT_REQUIRED');
      if (host && registry.active === id && current?.connectionId === connectionId) return state();
      const replacing = Boolean(current && current.connectionId !== connectionId && registry.active === id && host);
      if (!current && registry.projects.length >= 100) throw new Error('CODE_PROJECT_LIMIT');
      const connection = options.connection(connectionId);
      // Atomically refuse new work while inspecting/switching the previous project.
      if (previous) {
        if (previous.pauseAdmission()) throw new Error('CODE_PROJECT_BUSY');
        const client = await connectApplication(previous.credentialsPath);
        const result = await client.command({ method: 'session.list' });
        if (!result.ok || result.data.kind !== 'sessions') throw new Error('CODE_STATE_UNAVAILABLE');
        if (result.data.sessions.some(session => session.runs.some(run => !['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status)))) throw new Error('CODE_PROJECT_BUSY');
      }
      const task = (await tasks()).list().find(value => value.workspace === workspace);
      if (task) { if (task.status !== 'ready') throw new Error('TASK_NOT_READY'); await (await tasks()).inspect(task.id); }
      // A connection change shares the same workspace lease. Stop only after the idle check.
      if (replacing && previous) {await previous.close(); host = undefined; previous = undefined;}
      let next: Host;
      try {
      next = await startCodeHost({ workspace, directory: options.directory, recover: true, ...connection,
        engine: {...connection.engine, ...(task ? {stateDirectory: task.stateDirectory} : {})} });
      try {
        const project = { id, workspace, connectionId, label: path.basename(workspace) || workspace, isGitRepository: inspected.isGitRepository };
        const updated = { version: 1 as const, active: id, projects: [...registry.projects.filter(value => value.id !== id), project] };
        options.save(updated); registry = updated;
      } catch (failure) { await next.close(); throw failure; }
      host = next; error = null;
      if (previous) { await previous.close(); previous = undefined; }
      return state();
      } catch (failure) {
        if (replacing && current && !host) {
          try {const old = options.connection(current.connectionId); host = await startCodeHost({workspace, directory: options.directory, recover: true, ...old, engine: {...old.engine, ...(task ? {stateDirectory: task.stateDirectory} : {})}});}
          catch {error = 'CODE_PROJECT_UNAVAILABLE';}
        }
        throw failure;
      }
    } finally { if (previous && previous === host) previous.resumeAdmission(); busy = false; finish(); }
  };
  const select = async (id: string) => {
    const project = registry.projects.find(value => value.id === id);
    if (!project) throw new Error('CODE_PROJECT_NOT_FOUND');
    return open(project.workspace, project.connectionId);
  };
  const removalTargets = new Map<string, string>();
  return { state, open, select,
    async configure(id: string, connectionId: string) {
      const project = registry.projects.find(value => value.id === id);
      if (!project || registry.active !== id) throw new Error('CODE_SELECT_PROJECT_FIRST');
      return open(project.workspace, connectionId);
    }, currentHost: () => host,
    async worktrees() { const source = await sourceProject(); return (await tasks()).list(sourceKey(source.workspace)); },
    async createWorktree(input: unknown) { const source = await sourceProject(); return (await tasks()).create({key: sourceKey(source.workspace), workspace: source.workspace}, input); },
    async openWorktree(id: string) { const source = await sourceProject(), store = await tasks(), task = store.get(id);
      if (task.sourceWorkspace !== source.workspace) throw new Error('TASK_SOURCE_CHANGED');
      await store.inspect(id); await open(task.workspace, source.connectionId); return state(); },
    async reviewWorktreeRemoval(id: string) { const source = await sourceProject(), store = await tasks(), task = store.get(id);
      if (task.sourceWorkspace !== source.workspace) throw new Error('TASK_SOURCE_CHANGED');
      if (host && registry.projects.find(value => value.id === registry.active)?.workspace === task.workspace) throw new Error('TASK_CURRENTLY_OPEN');
      const review = await store.reviewRemoval(id); removalTargets.set(review.ticketId, id);
      while(removalTargets.size > 128) removalTargets.delete(removalTargets.keys().next().value!); return review; },
    async removeWorktree(ticketId: string) { const id = removalTargets.get(ticketId); removalTargets.delete(ticketId);
      if (!id) throw new Error('TASK_REVIEW_REQUIRED');
      const store = await tasks(), task = store.get(id);
      if (host && registry.projects.find(value => value.id === registry.active)?.workspace === task.workspace) throw new Error('TASK_CURRENTLY_OPEN');
      const removed = await store.remove(ticketId);
      const updated = {...registry, projects: registry.projects.filter(value => value.workspace !== task.workspace)};
      options.save(updated); registry = updated; return removed; },
    async restore() { if (registry.active) try { await select(registry.active); } catch (failure) { error = failure instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(failure.message) ? failure.message : 'CODE_PROJECT_UNAVAILABLE'; } return state(); },
    async close() { closed = true; await settled; await stop(); },
  };
}
