import { pilotDiagnostics } from '../pilot/diagnostics.js';
import { createTerminalHost, type NativeBridge } from '../terminal.js';
import type { DesktopLifecycle } from '../desktop-lifecycle.js';
import type { startAssistantHost } from '../host.js';
import { workspaceRequest } from './workspace.js';
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { HarnessClientRun } from '@zhivex-ai/harness/protocol';
import { connectAssistant, type AssistantCommand } from '../client.js';
import { dayWindow, localDate, validZone } from '../automation/time.js';
import type { AgendaSource } from '../automation/summary.js';
export interface AssistantWebOptions {
  native?: NativeBridge;
  lifecycle?: Pick<DesktopLifecycle, 'state' | 'action'>;
  /** Trusted native selector; a browser may request a dialog, never supply a root path. */
  chooseProject?: () => Promise<string | null>;
  port?: number;
  timeZone?: string;
  assetsDirectory?: string;
  setup?: {
    state(): unknown;
    action(name: string, input: unknown): Promise<unknown>;
  };
}
export interface WebHost {
  application?: Awaited<ReturnType<typeof import('../application.js').openAssistantApplication>> | undefined;
  daily?: Awaited<ReturnType<typeof startAssistantHost>>['daily'];
  taskMetrics?: Awaited<ReturnType<typeof startAssistantHost>>['taskMetrics'];
  runPrompt?: (runId: string) => Promise<string | undefined>;
  credentialsPath: string;
  diagnostics(): unknown;
  agendaSource?: AgendaSource | undefined;
  approvalDetails?: ((run: HarnessClientRun) => Promise<unknown>) | undefined;
  reviewTools?: readonly string[] | undefined;
  automation?:
    | {
        status(): unknown;
        command(text: string): string;
      }
    | undefined;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = z.string().min(1).max(240),
  key = z.string().uuid();
export async function startAssistantWeb(
  source: WebHost | (() => WebHost | undefined),
  options: AssistantWebOptions = {},
) {
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!validZone(zone)) throw new Error('ASSISTANT_WEB_ZONE_INVALID');
  const assets = await realpath(
    options.assetsDirectory ?? fileURLToPath(new URL('../web/dist', import.meta.url)),
  );
  await stat(path.join(assets, 'index.html'));
  const currentHost = () => {
    const host = typeof source === 'function' ? source() : source;
    if (!host) throw new Error('SETUP_REQUIRED');
    return host;
  };
  const terminals = options.native ? createTerminalHost(options.native, () => currentHost().application) : undefined;
  let connectedHost: WebHost | undefined,
    client: Awaited<ReturnType<typeof connectAssistant>> | undefined;
  const token = randomBytes(32).toString('hex');
  const command = async (input: AssistantCommand) => {
    const host = currentHost();
    if (!client || connectedHost !== host) {
      client = await connectAssistant(host.credentialsPath);
      connectedHost = host;
    }
    const response = await client.command(input);
    if (!response.ok) throw new Error(response.error.code);
    return response.data;
  };
  const getRun = async (sessionId: string, runId: string) => {
    const data = await command({ method: 'run.get', sessionId, runId, includeReview: true });
    if (data.kind !== 'run') throw new Error('RUN_RESPONSE_INVALID');
    return data.run;
  };
  const review = async (run: HarnessClientRun) => {
    const host = currentHost();
    const requiresDetails = run.approvals.some((a) =>
      ['calendar_write_apply', ...(host.reviewTools ?? [])].includes(
        (
          a.action as {
            name?: string;
          }
        ).name ?? '',
      ),
    );
    const details = host.approvalDetails ? await host.approvalDetails(run) : null;
    const full = { runId: run.runId, revision: run.revision, approvals: run.approvals, details };
    return {
      ...full,
      digest: hash(full),
      canDecide:
        run.status === 'waiting_approval' &&
        run.approvals.length > 0 &&
        (!requiresDetails || Boolean(host.approvalDetails)) &&
        run.approvals.every(
          (a) =>
            a.expiresAt > Date.now() && (!a.filePreview || a.filePreview.status === 'complete'),
        ) &&
        JSON.stringify(full).length <= 100000,
    };
  };
  let origin = '',
    active = 0,
    runtimeRequests = 0;
  let setupMutation = false;
  let closing = false;
  const server = createServer(async (req, res) => {
    const styleNonce = randomBytes(18).toString('base64');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let admitted = false,
      runtimeAdmitted = false,
      setupAdmitted = false;
    try {
      if (req.headers.host !== new URL(origin).host) {
        json(403, { error: 'HOST_REJECTED' });
        return;
      }
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/api/')) {
        const auth = Buffer.from(req.headers.authorization ?? ''),
          expected = Buffer.from(`Bearer ${token}`);
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
          json(401, { error: 'AUTH_REQUIRED' });
          return;
        }
        if (
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.method !== 'GET' && req.headers.origin !== origin)
        ) {
          json(403, { error: 'ORIGIN_REJECTED' });
          return;
        }
        if (active >= 16) {
          json(429, { error: 'BUSY' });
          return;
        }
        active++;
        admitted = true;
        if (req.method === 'GET' && url.pathname === '/api/lifecycle') { json(200, options.lifecycle?.state() ?? { native: false }); return; }
        if (req.method === 'POST' && ['/api/lifecycle/action', '/api/terminal'].includes(url.pathname)) {
          if (req.headers['content-type'] !== 'application/json') throw new Error('CONTENT_TYPE_INVALID');
          let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('BODY_TOO_LARGE'); }
          const input: unknown = JSON.parse(body);
          if (url.pathname === '/api/lifecycle/action') { if (!options.lifecycle) throw new Error('NATIVE_REQUIRED'); json(200, await options.lifecycle.action(input)); }
          else { if (!terminals) throw new Error('NATIVE_REQUIRED'); terminals.pause(['draining', 'cancelling', 'closing'].includes(options.lifecycle?.state().phase ?? 'running')); json(200, await terminals.action(input)); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/pilot') { json(200,await pilotDiagnostics());return; }
        if (req.method === 'GET' && url.pathname === '/api/setup') {
          json(200, options.setup?.state() ?? { managed: false });
          return;
        }
        if (url.pathname.startsWith('/api/setup/')) {
          if (!options.setup) {
            json(404, { error: 'SETUP_UNAVAILABLE' });
            return;
          }
          if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
            json(405, { error: 'METHOD_REJECTED' });
            return;
          }
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 16384) {
              json(413, { error: 'BODY_TOO_LARGE' });
              return;
            }
          }
          if (setupMutation || runtimeRequests) {
            json(409, { error: 'SETUP_BUSY' });
            return;
          }
          setupMutation = true;
          setupAdmitted = true;
          json(
            200,
            await options.setup.action(url.pathname.slice('/api/setup/'.length), JSON.parse(body)),
          );
          return;
        }
        if (setupMutation) {
          json(409, { error: 'SETUP_BUSY' });
          return;
        }
        if (url.pathname !== '/api/workspace/events') { runtimeRequests++; runtimeAdmitted = true; }
        const host = currentHost();
        if (url.pathname.startsWith('/api/workspace/')) {
          await workspaceRequest(req, res, url, host, { chooseProject: options.chooseProject, current: currentHost, closing: () => closing, terminalBusy: key=>terminals?.hasProject(key)??false });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/daily') {
          json(
            200,
            host.daily
              ? {
                  enabled: true,
                  ...host.daily.listTasks(),
                  reminders: host.daily.listReminders(),
                  proactive: host.daily.proactive.status(),
                }
              : { enabled: false, tasks: [], reminders: [] },
          );
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/task-metrics') {
          if (!host.taskMetrics) {
            json(404, { error: 'METRICS_UNAVAILABLE' });
            return;
          }
          json(200, await host.taskMetrics.report());
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const data = await command({ method: 'session.list' });
          if (data.kind !== 'sessions') throw new Error('SESSION_RESPONSE_INVALID');
          const sessions = await Promise.all(
            data.sessions.slice(0, 20).map(async (session) => ({
              sessionId: session.sessionId,
              title: session.title,
              runs: await Promise.all(
                session.runs.slice(-10).map(async (row) => {
                  const run = await getRun(session.sessionId, row.runId);
                  return {
                    runId: run.runId,
                    status: run.status,
                    output: run.output,
                    prompt: await host.runPrompt?.(run.runId),
                    revision: run.revision,
                    ...(run.status === 'waiting_approval' ? { review: await review(run) } : {}),
                  };
                }),
              ),
            })),
          );
          json(200, {
            diagnostics: host.diagnostics(),
            timeZone: zone,
            now: Date.now(),
            sessions,
            automation: host.automation?.status() ?? null,
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/agenda') {
          if (!host.agendaSource) {
            json(200, { connected: false, events: [], timeZone: zone });
            return;
          }
          const date = localDate(Date.now(), zone),
            window = dayWindow(date, zone);
          if (!window) throw new Error('DAY_MISSING');
          const events = [];
          const signal = AbortSignal.timeout(20000);
          let pageToken: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await host.agendaSource.list(
              {
                timeMin: new Date(window.start).toISOString(),
                timeMax: new Date(window.end).toISOString(),
                ...(pageToken ? { pageToken } : {}),
              },
              signal,
            );
            events.push(...result.events);
            pageToken = result.nextPageToken ?? undefined;
            if (result.complete && !pageToken) {
              json(200, { connected: true, events, date, timeZone: zone });
              return;
            }
            if (!pageToken) break;
          }
          throw new Error('AGENDA_INCOMPLETE');
        }
        if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
          json(405, { error: 'METHOD_REJECTED' });
          return;
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) {
            json(413, { error: 'BODY_TOO_LARGE' });
            return;
          }
        }
        const input: unknown = JSON.parse(body);
        if (
          url.pathname === '/api/task-metrics/feedback' ||
          url.pathname === '/api/task-metrics/link'
        ) {
          if (!host.taskMetrics) {
            json(404, { error: 'METRICS_UNAVAILABLE' });
            return;
          }
          try {
            json(
              200,
              await (url.pathname.endsWith('/feedback')
                ? host.taskMetrics.feedback(input)
                : host.taskMetrics.link(input)),
            );
          } catch (error) {
            if (
              error instanceof Error &&
              [
                'METRICS_REVIEW_STALE',
                'METRICS_TASK_PENDING',
                'METRICS_LINK_INVALID',
                'METRICS_TASK_NOT_FOUND',
                'METRICS_RUN_NOT_FOUND',
              ].includes(error.message)
            )
              json(409, { error: error.message });
            else throw error;
          }
          return;
        }
        if (url.pathname === '/api/message') {
          const value = z
            .strictObject({
              prompt: z.string().trim().min(1).max(8000),
              sessionId: id.optional(),
              key,
            })
            .parse(input);
          const data = value.sessionId
            ? await command({ method: 'session.get', sessionId: value.sessionId })
            : await command({
                method: 'session.create',
                title: 'Conversación web',
                idempotencyKey: `web-session-${value.key}`,
              });
          if (data.kind !== 'session') throw new Error('SESSION_RESPONSE_INVALID');
          const result = await command({
            method: 'run.start',
            sessionId: data.session.sessionId,
            expectedRevision: data.session.revision,
            idempotencyKey: `web-message-${value.key}`,
            prompt: value.prompt,
          });
          json(200, result);
          return;
        }
        if (url.pathname === '/api/decision') {
          const value = z
            .strictObject({
              sessionId: id,
              runId: id,
              digest: z.string().regex(/^[a-f0-9]{64}$/),
              approve: z.boolean(),
              key,
            })
            .parse(input);
          const run = await getRun(value.sessionId, value.runId),
            current = await review(run);
          if (!current.canDecide || current.digest !== value.digest) {
            json(409, { error: 'REVIEW_CHANGED' });
            return;
          }
          json(
            200,
            await command({
              method: 'approval.resolve',
              sessionId: value.sessionId,
              runId: value.runId,
              expectedRevision: run.revision,
              idempotencyKey: `web-decision-${value.key}`,
              decisions: run.approvals.map((a) => ({
                approvalId: a.approvalId,
                digest: a.digest,
                approve: value.approve,
              })),
            }),
          );
          return;
        }
        if (url.pathname === '/api/cancel') {
          const value = z.strictObject({ sessionId: id, runId: id, key }).parse(input);
          const run = await getRun(value.sessionId, value.runId);
          json(
            200,
            await command({
              method: 'run.cancel',
              sessionId: value.sessionId,
              runId: value.runId,
              expectedRevision: run.revision,
              idempotencyKey: `web-cancel-${value.key}`,
            }),
          );
          return;
        }
        if (url.pathname.startsWith('/api/proactive/')) {
          if (!host.daily) {
            json(409, { error: 'DAILY_MODULE_REQUIRED' });
            return;
          }
          const proactive = host.daily.proactive;
          const route = url.pathname.slice('/api/proactive/'.length);
          if (route === 'policy') json(200, proactive.configure(input));
          else if (route === 'watch') json(200, proactive.watch(input));
          else if (route === 'cancel-watch') json(200, proactive.cancelWatch(input));
          else if (route === 'dismiss') json(200, proactive.dismiss(input));
          else json(404, { error: 'NOT_FOUND' });
          return;
        }
        if (url.pathname === '/api/automation') {
          const value = z
            .strictObject({
              command: z
                .string()
                .max(300)
                .regex(/^\/(daily|memory)(?:\s|$)/),
            })
            .parse(input);
          if (!host.automation) {
            json(409, { error: 'TELEGRAM_CALENDAR_REQUIRED' });
            return;
          }
          json(200, { message: host.automation.command(value.command) });
          return;
        }
        json(404, { error: 'NOT_FOUND' });
        return;
      }
      if (req.method !== 'GET') {
        json(405, { error: 'METHOD_REJECTED' });
        return;
      }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = path.resolve(assets, '.' + relative);
      if (!target.startsWith(assets + path.sep)) {
        json(404, { error: 'NOT_FOUND' });
        return;
      }
      const canonical = await realpath(target);
      if (!canonical.startsWith(assets + path.sep)) {
        json(404, { error: 'NOT_FOUND' });
        return;
      }
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, {
        'content-type': mime[path.extname(canonical)] ?? 'application/octet-stream',
      });
      const content = await readFile(canonical);
      res.end(path.extname(canonical) === '.html' ? content.toString('utf8').replace('<head>', `<head><meta name="terminal-style-nonce" content="${styleNonce}">`) : content);
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]{1,90}$/.test(error.message)
          ? error.message
          : 'REQUEST_FAILED';
      if (!res.headersSent) json(400, { error: code });
      else res.end();
    } finally {
      if (admitted) active--;
      if (runtimeAdmitted) runtimeRequests--;
      if (setupAdmitted) setupMutation = false;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WEB_LISTEN_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/#token=${token}`,
    origin,
    async close() {
      closing = true;
      await terminals?.close();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
