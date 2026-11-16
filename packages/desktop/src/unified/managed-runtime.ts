import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';
import type { CodeProjectState } from '@zhivex-ai/harness/application';
import type { AssistantSetupState } from './bridge.js';
export interface RuntimeSnapshot { state: AssistantSetupState; credentialsPath?: string; code: CodeProjectState; codeCredentialsPath?: string }
export type ShutdownSummary = Awaited<ReturnType<Awaited<ReturnType<typeof import('@zhivex-ai/harness/assistant/managed/setup').startManagedAssistant>>['shutdownSummary']>>;
/** Only the main process can reach this channel; credentials never enter the renderer. */
export function createManagedRuntime(entry: string, directory: string, credentialEntry: string) {
  const child = utilityProcess.fork(entry, [], { serviceName: 'Zhivex Assistant', stdio: 'ignore', env: {...process.env, PATH: [...new Set([...(process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).filter(value => path.isAbsolute(value)), path.join(os.homedir(), '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin'])].join(path.delimiter)} });
  let sequence = 0, exited = false, ownsService = true;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.on('message', message => {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  });
  child.on('exit', () => {
    exited = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('ASSISTANT_PROCESS_EXITED')); }
    pending.clear();
  });
  const call = <T>(method: string, input?: unknown): Promise<T> => new Promise((resolve, reject) => {
    if (exited) { reject(new Error('ASSISTANT_PROCESS_EXITED')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ASSISTANT_REQUEST_TIMEOUT')); }, 120_000);
    pending.set(id, { resolve, reject, timer }); child.postMessage({ id, method, input });
  });
  return {
    isAlive: () => !exited,
    ownsService: () => ownsService,
    start: async () => { const result = await call<RuntimeSnapshot & {ownsService: boolean}>('init', { directory, credentialEntry }); ownsService = result.ownsService; return result; },
    reconnect: async () => { const result = await call<RuntimeSnapshot & {ownsService: boolean; recovered: boolean}>('reconnect'); ownsService = result.ownsService; return result; },
    prepareReplyWatch: (input: unknown) => call<{requestId: string; proposalDigest: string}>('reply-watch-proposal', input),
    prepareMailDraft: (input: unknown) => call<{requestId: string; proposalDigest: string}>('mail-draft-proposal', input),
    prepareCalendarCreation: (input: unknown) => call<{operationId: string; proposalDigest: string}>('calendar-create-proposal', input),
    agenda: (input: unknown) => call<import('@zhivex-ai/harness/application/client').AgendaSnapshot>('agenda', input),
    authorization: () => call<{url: string | null}>('authorization'),
    automation: (input: unknown) => call<import('@zhivex-ai/harness/application/client').AutomationSnapshot>('automation', input),
    notes: (input: unknown) => call<import('@zhivex-ai/harness/application/client').NotesSnapshot>('notes', input),
    personalState: (input: unknown) => call<import('@zhivex-ai/harness/application/client').PersonalSnapshot>('personal-state', input),
    catalog: () => call<import('@zhivex-ai/harness/application/protocol').ApplicationCatalogSnapshot>('catalog'),
    state: () => call<RuntimeSnapshot>('state'),
    shutdownSummary: () => call<ShutdownSummary>('shutdown-summary'),
    action: (name: string, value: unknown) => call<RuntimeSnapshot>('action', { name, value }),
    code: (method: 'code-configure' | 'code-open' | 'code-select' | 'code-retry', input?: unknown) => call<RuntimeSnapshot>(method, input),
    tools: (action: string, value?: unknown) => call<unknown>('code-tools', {action, value}),
    delivery: (action: string, value?: unknown) => call<unknown>('code-delivery', {action, value}),
    async close() { try { if (!exited) await call('close'); } finally { child.kill(); } },
  };
}
