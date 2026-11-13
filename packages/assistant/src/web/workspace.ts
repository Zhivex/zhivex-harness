import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { WebHost } from './server.js';
import type { AssistantApplicationResult } from '../application-contracts.js';

function value<T>(result: AssistantApplicationResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}

/** Called only after the web server's bearer, Origin and admission checks. */
export async function workspaceRequest(req: IncomingMessage, res: ServerResponse, url: URL, host: WebHost, options: {
  chooseProject?: (() => Promise<string | null>) | undefined;
  current: () => WebHost;
  closing: () => boolean;
  terminalBusy?: ((key:string)=>boolean) | undefined;
}) {
  const json = (body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const app = host.application;
  const route = url.pathname.slice('/api/workspace/'.length);
  if (route === 'index' && req.method === 'GET') {
    if (!app) return json({ enabled: false, canChoose: false, projects: [], conversations: [] });
    const [projects, conversations] = await Promise.all([app.client.projects(), app.client.conversations()]);
    return json({ enabled: true, canChoose: Boolean(options.chooseProject), execution: app.execution, diagnostics: host.diagnostics(), projects: value(projects), conversations: value(conversations) });
  }
  if (!app) throw new Error('WORKSPACE_UNAVAILABLE');
  if (req.method === 'GET') {
    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (route === 'snapshot') {
      const snapshot = value(await app.client.snapshot(conversationId));
      return json({ ...snapshot, session: { ...snapshot.session, title: app.redactText(snapshot.session.title ?? '') }, runs: snapshot.runs.map(run => ({ runId: run.runId, revision: run.revision, status: run.status, output: app.redactText(run.output).slice(-262144), approvals: [] })) });
    }
    if (route === 'work') return json(await app.work());
    if (route === 'outputs') return json(await app.outputs({ conversationId, runId: url.searchParams.get('runId') }));
    if (route === 'history') return json(await app.inspectReview({ conversationId, runId: url.searchParams.get('runId'), offset: Number(url.searchParams.get('offset') ?? 0) }));
    if (route === 'files') return json(await app.files({ projectKey: url.searchParams.get('projectKey'), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }));
    if (route === 'file') return json(await app.file({ projectKey: url.searchParams.get('projectKey'), path: url.searchParams.get('path'), startLine: Number(url.searchParams.get('startLine') ?? 1) }));
    if (route === 'events') {
      const after = z.number().int().nonnegative().safe().parse(Number(url.searchParams.get('after') ?? 0));
      const until = Date.now() + 5000;
      do {
        if (options.closing() || res.destroyed) { if (!res.destroyed) res.setHeader('connection', 'close'); res.end(); return; }
        if (options.current() !== host) throw new Error('WORKSPACE_CHANGED');
        const attachment = value(await app.client.attach({ conversationId, after }));
        if (attachment.page.nextCursor !== after || attachment.page.cursorExpired || Date.now() >= until) return json(attachment);
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (!res.destroyed);
      return;
    }
    throw new Error('NOT_FOUND');
  }
  if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') throw new Error('METHOD_REJECTED');
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) throw new Error('BODY_TOO_LARGE'); }
  const input: unknown = JSON.parse(body);
  if (route === 'preview') return json(await app.previewAction(input));
  if (route === 'tasks') return json(await app.taskAction(input,options.terminalBusy));
  if (route === 'review') return json(value(await app.client.review(input as Parameters<typeof app.client.review>[0])));
  if (route === 'decision') {
    const result = value(await app.client.decide(input as Parameters<typeof app.client.decide>[0]));
    if (!result.ok) throw new Error(result.error.code);
    return json({ kind: result.data.kind });
  }
  if (route === 'review-action') return json(await app.reviewAction(input));
  if (route === 'select') {
    z.object({}).strict().parse(input);
    if (!options.chooseProject) throw new Error('NATIVE_SELECTION_REQUIRED');
    const selected = await options.chooseProject();
    if (!selected) return json({ cancelled: true });
    if (options.current() !== host || options.closing()) throw new Error('WORKSPACE_CHANGED');
    return json({ cancelled: false, project: value(await app.client.registerProject(await app.selectProject(selected))) });
  }
  if (route === 'create') {
    const parsed = z.object({ projectKey: z.string().min(1).max(128), title: z.string().max(256).optional(), key: z.string().uuid() }).strict().parse(input);
    return json(value(await app.client.createConversation({ context: { kind: 'project', projectKey: parsed.projectKey }, idempotencyKey: parsed.key, ...(parsed.title ? { title: parsed.title } : {}) })));
  }
  if (route === 'message') {
    const response = await app.send(input);
    if (!response.ok) throw new Error(response.error.code);
    return json({ kind: response.data.kind, ...(response.data.kind === 'run' ? { runId: response.data.run.runId, status: response.data.run.status } : {}) });
  }
  if (route === 'cancel') {
    const parsed = z.object({ conversationId: z.string().min(1).max(256), runId: z.string().min(1).max(128), key: z.string().uuid() }).strict().parse(input);
    const snapshot = value(await app.client.snapshot(parsed.conversationId));
    const run = snapshot.runs.find(r => r.runId === parsed.runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const response = value(await app.client.command({ conversationId: parsed.conversationId, command: { method: 'run.cancel', sessionId: snapshot.binding.sessionId, runId: run.runId, expectedRevision: run.revision, idempotencyKey: parsed.key } }));
    if (!response.ok) throw new Error(response.error.code);
    return json({ kind: response.data.kind });
  }
  throw new Error('NOT_FOUND');
}
