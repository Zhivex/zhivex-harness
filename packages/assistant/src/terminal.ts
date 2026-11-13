import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { openAssistantApplication } from './application.js';
export interface NativeBridge { request(method: string, input?: Record<string, unknown>): Promise<unknown> }
export interface TerminalSession { id: string; projectKey: string; status: 'running' | 'exited'; exitCode?: number }
/** Human-operated PTYs only. Not registered as an agent tool or ordinary protocol command. */
export function createTerminalHost(native: NativeBridge, application: () => Pick<Awaited<ReturnType<typeof openAssistantApplication>>, 'terminalRoot'> & Partial<Pick<Awaited<ReturnType<typeof openAssistantApplication>>, 'assertProjectMutable'>> | undefined) {
  const sessions = new Map<string, TerminalSession>(); let paused = false;
  const getApp = async () => { const app = await application(); if (!app) throw new Error('WORKSPACE_UNAVAILABLE'); return app; };
  return {
    hasProject(key:string) { return [...sessions.values()].some(session=>session.projectKey===key); },
    pause(value: boolean) { paused = value; },
    async action(input: unknown) {
      const value = z.discriminatedUnion('action', [
        z.object({ action: z.literal('list'), projectKey: z.string() }).strict(),
        z.object({ action: z.literal('open'), projectKey: z.string(), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(),
        z.object({ action: z.literal('read'), id: z.string().uuid(), after: z.number().int().nonnegative().safe() }).strict(),
        z.object({ action: z.literal('write'), id: z.string().uuid(), data: z.string().max(8192) }).strict(),
        z.object({ action: z.literal('resize'), id: z.string().uuid(), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(),
        z.object({ action: z.literal('close'), id: z.string().uuid() }).strict(),
      ]).parse(input);
      const app = await getApp();
      if ('projectKey' in value) await app.terminalRoot(value.projectKey);
      if (value.action === 'list') return { sessions: [...sessions.values()].filter(session => session.projectKey === value.projectKey) };
      if (value.action === 'open') {
        app.assertProjectMutable?.(value.projectKey);
        if (paused || sessions.size >= 8) throw new Error('TERMINAL_CAPACITY');
        const id = randomUUID(), cwd = await app.terminalRoot(value.projectKey);
        const session: TerminalSession = { id, projectKey: value.projectKey, status: 'running' };
        sessions.set(id, session); // Reserve before native I/O; never retry an ambiguous spawn.
        try { await native.request('terminal-open', { id, cwd, cols: value.cols, rows: value.rows }); } catch (error) { session.status = 'exited'; throw error; }
        return session;
      }
      const session = sessions.get(value.id); if (!session) throw new Error('TERMINAL_NOT_FOUND');
      await app.terminalRoot(session.projectKey);
      if (paused && ['write', 'resize'].includes(value.action)) throw new Error('APPLICATION_DRAINING');
      if(['write','resize'].includes(value.action))app.assertProjectMutable?.(session.projectKey);
      const { action, ...payload } = value;
      const result = await native.request('terminal-' + action, payload) as { exitCode?: number };
      if (result.exitCode !== undefined) { session.status = 'exited'; session.exitCode = result.exitCode; }
      if (action === 'close') sessions.delete(value.id);
      return result;
    },
    async close() { paused = true; if (sessions.size) await native.request('terminal-close-all'); sessions.clear(); },
  };
}
