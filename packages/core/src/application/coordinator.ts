import type {ApplicationCatalogSnapshot, ApplicationHello, ApplicationError} from './contracts.js';
import {connectApplication} from './client.js';
import {readApplicationAgenda, prepareApplicationCalendarCreation} from './agenda.js';
import {applicationAutomation} from './automation.js';
import {readNotes} from './notes.js';
import {readPersonalState} from './personal-state.js';
import {manageApplication} from './management.js';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { startManagedAssistant } from './assistant/managed/setup.js';
import type { CoordinatorSnapshot } from './coordinator-client.js';

const requestSchema = z.object({version: z.number().int(), method: z.enum(['reply-watch-proposal', 'mail-draft-proposal', 'catalog', 'calendar-create-proposal', 'notes', 'agenda', 'authorization', 'automation', 'hello', 'personal-state', 'management', 'state', 'shutdown', 'shutdown-summary', 'action', 'code-configure', 'code-open', 'code-select', 'code-retry', 'code-tools', 'code-delivery']), input: z.unknown().optional()}).strict();
const actionSchema = z.object({name: z.string(), value: z.unknown().optional()}).strict();
const toolSchema = z.object({action: z.string(), value: z.unknown().optional()}).strict();
/** One manager lease and one authenticated control endpoint per private application directory. */
export async function startApplicationCoordinator(directory: string, options: Parameters<typeof startManagedAssistant>[1]) {
  const manager = await startManagedAssistant(directory, options);
  let queue = Promise.resolve(), closing = false, closePromise: Promise<void> | undefined;
  let socketOwned = false, credentialsOwned = false;
  directory = await realpath(directory);
  const socketPath = path.join(directory, 'coordinator.sock'), credentialsPath = path.join(directory, 'coordinator.json');
  const token = randomBytes(32).toString('hex'), generation = randomUUID();
  const state = (): CoordinatorSnapshot => ({state: manager.state(), credentialsPath: manager.currentHost()?.credentialsPath, code: manager.codeProjects.state(), codeCredentialsPath: manager.codeProjects.currentHost()?.credentialsPath});
  const readController = new AbortController();
  const dispatch = async (raw: unknown) => {
    const request = requestSchema.parse(raw);
    if (request.version !== 1) throw new Error('COORDINATOR_VERSION_UNSUPPORTED');
    const projects = manager.codeProjects;
    switch (request.method) {
      case 'hello': {
        const input = z.object({versions: z.array(z.number().int()).min(1).max(16)}).strict().parse(request.input ?? {versions:[1]});
        if (!input.versions.includes(1)) throw new Error('COORDINATOR_VERSION_UNSUPPORTED');
        return {version: 1, projectionVersion: 1, activityVersion: 1, generation, capabilities: ['application.state', 'application.setup', 'application.code', 'application.shutdown-preview', 'application.shutdown', 'application.management', 'application.personal-state', 'application.automation', 'application.authorization', 'application.agenda', 'application.notes', 'application.calendar-create-proposal', 'application.code-context', 'application.catalog', 'application.mail-draft-proposal', 'application.reply-watch-proposal'] } satisfies ApplicationHello;
      }
      case 'catalog': {
        const snapshot = manager.state(), code = projects.state();
        const runtimes: ApplicationCatalogSnapshot['runtimes'] = [];
        for (const [area, host, id] of [['assistant', manager.currentHost(), snapshot.profiles.find(profile => profile.active)?.id], ['code', projects.currentHost(), code.active]] as const) {
          if (host && id) runtimes.push({area, id, projectId:(await connectApplication(host.credentialsPath)).projectId, binding:host.binding()});
        }
        const body = {locked:snapshot.locked, agents:snapshot.profiles, connections:snapshot.connections, projects:code, runtimes};
        return {schemaVersion:1, generation, revision:createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body} satisfies ApplicationCatalogSnapshot;
      }
      case 'state': return state();
      case 'reply-watch-proposal': {
        const input = z.object({projectId: z.string(), watch: z.unknown()}).strict().parse(request.input);
        const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
        if ((await connectApplication(host.credentialsPath)).projectId !== input.projectId) throw new Error('APPLICATION_SCOPE_CHANGED');
        if (!host.daily || !host.binding().tools.includes('daily_write_apply_reply_watch')) throw new Error('PROACTIVE_UNAVAILABLE');
        return host.daily.proactive.proposeWatch(input.watch);
      }
      case 'mail-draft-proposal': {
        const input = z.object({projectId: z.string(), provider: z.enum(['google', 'microsoft']), draft: z.unknown()}).strict().parse(request.input);
        const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
        if ((await connectApplication(host.credentialsPath)).projectId !== input.projectId) throw new Error('APPLICATION_SCOPE_CHANGED');
        const prepare = host.mailDrafts?.[input.provider]; if (!prepare) throw new Error('MAIL_DRAFT_UNAVAILABLE');
        return prepare(input.draft);
      }
      case 'calendar-create-proposal': return prepareApplicationCalendarCreation(manager, request.input);
      case 'agenda': return readApplicationAgenda(manager, request.input, readController.signal);
      case 'authorization': return {url: manager.authorizationUrl() ?? null};
      case 'automation': return applicationAutomation(manager, request.input);
      case 'notes': return readNotes(manager, request.input);
      case 'personal-state': return readPersonalState(manager, request.input);
      case 'management': return manageApplication(manager, request.input);
      case 'shutdown': z.object({confirmed: z.literal(true)}).strict().parse(request.input); return {status: 'stop-requested'};
      case 'shutdown-summary': return manager.shutdownSummary();
      case 'action': {const input = actionSchema.parse(request.input); await manager.action(input.name, input.value); return state();}
      case 'code-configure': {const input = z.object({id: z.string(), connectionId: z.string()}).strict().parse(request.input); await projects.configure(input.id, input.connectionId); return state();}
      case 'code-open': {const input = z.object({workspace: z.string(), connectionId: z.string()}).strict().parse(request.input); await projects.open(input.workspace, input.connectionId); return state();}
      case 'code-select': {const input = z.object({id: z.string()}).strict().parse(request.input); await projects.select(input.id); return state();}
      case 'code-retry': await projects.restore(); return state();
      case 'code-delivery': {const input = toolSchema.parse(request.input), host = projects.currentHost(); if (!host) throw new Error('CODE_UNAVAILABLE'); return host.delivery(input.action, input.value);}
      case 'code-tools': {
        const input = toolSchema.parse(request.input);
        switch(input.action) {
          case 'list': return projects.worktrees();
          case 'create': return projects.createWorktree(input.value);
          case 'open': await projects.openWorktree(z.string().uuid().parse(input.value)); return state();
          case 'review-removal': return projects.reviewWorktreeRemoval(z.string().uuid().parse(input.value));
          case 'remove': return projects.removeWorktree(z.string().uuid().parse(input.value));
          case 'context': {
            const inputScope = z.object({projectId: z.string().min(1)}).strict().parse(input.value);
            const host = projects.currentHost(); if (!host) throw new Error('CODE_UNAVAILABLE');
            if ((await connectApplication(host.credentialsPath)).projectId !== inputScope.projectId || projects.currentHost() !== host) throw new Error('APPLICATION_SCOPE_CHANGED');
            return host.context();
          }
          case 'checks': {const host = projects.currentHost(); if (!host) throw new Error('CODE_UNAVAILABLE'); return host.checks();}
          default: throw new Error('CODE_ACTION_INVALID');
        }
      }
    }
  };
  let close!: () => Promise<void>;
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(value));};
    const authorization = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== 'POST' || request.url !== '/application' || request.headers.origin || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {send(403, {ok: false, error: 'COORDINATOR_UNAUTHORIZED'}); return;}
    try {
      if (closing) throw new Error('COORDINATOR_CLOSING');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {size += chunk.length; if (size > 128 * 1024) throw new Error('COORDINATOR_REQUEST_TOO_LARGE'); chunks.push(chunk);}
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const readOnly = input?.method === 'agenda';
      const operation = readOnly ? dispatch(input) : queue.then(() => {if (closing) throw new Error('COORDINATOR_CLOSING'); return dispatch(input);});
      if (!readOnly) queue = operation.then(() => {}, () => {});
      send(200, {ok: true, result: await operation});
      if (input.method === 'shutdown') void close().catch(() => {});
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,90}$/.test(error.message) ? error.message : 'COORDINATOR_REQUEST_FAILED';
      const detail: ApplicationError = {schemaVersion:1, code, recovery:code === 'COORDINATOR_VERSION_UNSUPPORTED' ? 'upgrade' : code === 'APPLICATION_SCOPE_CHANGED' ? 'refresh' : /BUSY|UNCONFIRMED|UNAVAILABLE|CLOSING/.test(code) ? 'reconcile' : 'review-request'};
      send(200, {ok: false, error: code, detail});
    }
  });
  server.requestTimeout = 15_000;
  const removeOwned = async () => {if (credentialsOwned) await unlink(credentialsPath); if (socketOwned) await unlink(socketPath).catch(error => {if (error.code !== 'ENOENT') throw error;});};
  try {
    if (Buffer.byteLength(socketPath) > 100) throw new Error('LOCAL_SERVICE_SOCKET_PATH_TOO_LONG');
    // Only the manager lease holder can remove a dead owner's socket.
    try {const info = await lstat(socketPath); if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error('COORDINATOR_SOCKET_UNSAFE'); await unlink(socketPath);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(socketPath, () => {server.off('error', reject); resolve();});}); socketOwned = true;
    await chmod(socketPath, 0o600);
    const temporary = credentialsPath + '.' + randomBytes(8).toString('hex');
    try {await writeFile(temporary, JSON.stringify({schemaVersion: 1, socketPath, token}), {mode: 0o600, flag: 'wx'}); await rename(temporary, credentialsPath); credentialsOwned = true;} finally {await unlink(temporary).catch(() => {});}
  } catch (error) {if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await removeOwned(); await manager.close(); throw error;}
  close = () => closePromise ??= (async () => {closing = true; readController.abort(); await queue; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); try {await manager.close();} finally {await removeOwned();}})();
  return {credentialsPath, state, close};
}

/** Both launchers use the same discovery and lease-race resolution. Attached clients never own shutdown. */
export async function acquireApplicationCoordinator(directory: string, options: Parameters<typeof startManagedAssistant>[1]) {
  const {connectCoordinator} = await import('./coordinator-client.js');
  let owner: Awaited<ReturnType<typeof startApplicationCoordinator>> | undefined;
  let client: Awaited<ReturnType<typeof connectCoordinator>> | undefined;
  try {client = await connectCoordinator(directory);} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (!(error instanceof Error) || error.message !== 'LOCAL_SERVICE_UNAVAILABLE')) throw error;
    try {owner = await startApplicationCoordinator(directory, options);} catch (failure) {
      if (!(failure instanceof Error) || failure.message !== 'SETUP_ALREADY_RUNNING') throw failure;
      // The owner may still be reading credentials (8s native / 10s custom store).
      // Match discovery's startup budget; a live lease is never permission to take over.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {client = await connectCoordinator(directory); break;}
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (!(error instanceof Error) || error.message !== 'LOCAL_SERVICE_UNAVAILABLE')) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (!client) throw failure;
    }
    try {client ??= await connectCoordinator(directory);} catch (failure) {await owner?.close(); throw failure;}
  }
  return {client, ownsService: Boolean(owner), close: async () => {await owner?.close();}};
}
