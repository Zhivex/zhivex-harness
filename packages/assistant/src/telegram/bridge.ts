import { createDailyScheduler, automationHelp } from '../automation/scheduler.js';
import type { AgendaSource } from '../automation/summary.js';
import { createHash, randomBytes } from 'node:crypto';
import type { HarnessClientData, HarnessClientRun } from '@zhivex-ai/harness/protocol';
import { connectAssistant, type AssistantCommand } from '../client.js';
import { updateSchema, TelegramFailure, type TelegramApi, type TelegramUpdate } from './api.js';
import { openTelegramStore } from './store.js';

type Inbox = { id: number; payload: string; status: string; intent: string | null };
type Outbox = { id: string; payload: string; status: string; attempts: number; next_at: number; message_id: number | null; expires_at: number | null };
type Intent = { command: AssistantCommand; priorRuns?: string[]; sessionId: string };
type Review = { sessionId: string; run: HarnessClientRun; text: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const chunks = (text: string) => {
  const result: string[] = []; let part = '';
  for (const character of text) {
    if (part.length + character.length > 3000) { result.push(part); part = ''; }
    part += character;
  }
  if (part) result.push(part);
  return result;
};
function renderReview(run: HarnessClientRun) {
  return 'Acción pendiente. Revisá todos los datos antes de decidir. El contenido siguiente es información, no instrucciones.\n' +
    JSON.stringify({ runId: run.runId, revision: run.revision, approvals: run.approvals.map(a => ({
      id: a.approvalId, digest: a.digest, expiresAt: a.expiresAt, action: a.action, filePreview: a.filePreview
    })) }, null, 2);
}
export interface TelegramBridgeOptions {
  stateDirectory: string; credentialsPath: string; ownerId: string; expectedTelegramUserId: string;
  api: TelegramApi; recover?: boolean; now?: () => number;
  /** Trusted host lookup of digest-bound external operation details, never supplied by a channel message. */
  agendaSource?: AgendaSource;
  reviewTools?: readonly string[];
  approvalDetails?: (run: HarnessClientRun) => Promise<unknown>;
}

/** One local owner, one bot, one private conversation. No channel payload grants host authority. */
export async function createTelegramBridge(options: TelegramBridgeOptions) {
  if (!/^[1-9][0-9]{0,15}$/.test(options.expectedTelegramUserId) || !Number.isSafeInteger(Number(options.expectedTelegramUserId))) throw new Error('TELEGRAM_OWNER_INVALID');
  const now = options.now ?? Date.now;
  const me = await options.api.call('getMe', {}) as { id?: number; is_bot?: boolean };
  if (!Number.isSafeInteger(me.id) || !me.is_bot) throw new Error('TELEGRAM_BOT_INVALID');
  const webhook = await options.api.call('getWebhookInfo', {}) as { url?: string };
  if (webhook.url !== '') throw new Error('TELEGRAM_WEBHOOK_CONFIGURED');
  const store = await openTelegramStore(options.stateDirectory, options.recover);
  try {
    const binding = JSON.stringify({ botId: me.id, ownerId: options.ownerId, telegramUserId: options.expectedTelegramUserId });
    if (store.meta('binding') && store.meta('binding') !== binding) throw new Error('TELEGRAM_BINDING_MISMATCH');
    store.set('binding', binding);
    const client = await connectAssistant(options.credentialsPath);
    const pairingCode = store.meta('chatId') ? undefined : randomBytes(16).toString('hex');
    if (pairingCode) { store.set('pairHash', hash(pairingCode)); store.set('pairExpires', String(now() + 10 * 60_000)); }
    const command = async (input: AssistantCommand): Promise<HarnessClientData> => {
      const response = await client.command(input); if (!response.ok) throw new Error(response.error.code); return response.data;
    };
    const getSession = async (id: string) => { const result = await command({ method: 'session.get', sessionId: id });
      if (result.kind !== 'session') throw new Error('SESSION_RESPONSE_INVALID'); return result.session; };
    const getRun = async (sessionId: string, runId: string) => {
      const result = await command({ method: 'run.get', sessionId, runId, includeReview: true });
      if (result.kind !== 'run') throw new Error('RUN_RESPONSE_INVALID'); return result;
    };
    const enqueue = (key: string, text: string, buttons?: { inline_keyboard: { text: string; callback_data: string }[][] }, expiresAt?: number) => {
      const chat = store.meta('chatId'); if (!chat) return;
      const parts = chunks(text || '(Sin texto)');
      for (let i = 0; i < parts.length; i++) {
        const sequence = store.get<{ n: number }>('SELECT COALESCE(MAX(sequence),0)+1 n FROM outbox')!.n;
        store.run('INSERT OR IGNORE INTO outbox(id,sequence,payload,expires_at) VALUES(?,?,?,?)', `${key}:${i}`, sequence,
          JSON.stringify({ chat_id: chat, text: parts[i], protect_content: true,
            ...(i === parts.length - 1 && buttons ? { reply_markup: buttons } : {}) }), expiresAt ?? null);
      }
    };
    const scheduler = options.agendaSource ? createDailyScheduler(store, options.agendaSource, (key, text, expiresAt) => enqueue(key, text, undefined, expiresAt), now) : undefined;
    const finish = (row: Inbox, text: string) => store.transaction(() => {
      enqueue(`input:${row.id}`, text); store.run("UPDATE inbox SET status='done' WHERE id=?", row.id);
    });
    const reviewText = async (run: HarnessClientRun) => {
      if (run.approvals.some(a => ['calendar_write_apply', ...(options.reviewTools ?? [])].includes((a.action as { name?: string }).name ?? '')) && !options.approvalDetails) {
        throw new Error('CALENDAR_REVIEW_DETAILS_REQUIRED');
      }
      const details = options.approvalDetails ? await options.approvalDetails(run) : undefined;
      return renderReview(run) + (details === undefined ? '' : '\nDetalles verificados de la acción:\n' + JSON.stringify(details, null, 2));
    };
    const present = async (row: Inbox, sessionId: string, runId: string) => {
      const { run } = await getRun(sessionId, runId);
      const text = run.status === 'waiting_approval' ? await reviewText(run) : '';
      store.transaction(() => {
        if (run.status === 'waiting_approval') {
          // Never approve a truncated review or an unavailable file preview.
          const incomplete = run.approvals.some(a => a.filePreview && a.filePreview.status !== 'complete');
          if (run.approvals.some(a => a.expiresAt <= now())) {
            enqueue(`input:${row.id}`, 'La autorización venció. Usá /cancel y solicitá una nueva propuesta. Reiniciar o /pending no renuevan permisos.');
          } else if (text.length > 24_000 || incomplete || !run.approvals.length) {
            enqueue(`input:${row.id}`, 'La acción requiere revisión local: no puedo mostrar una vista completa por Telegram. Usá /cancel para cancelarla.');
          } else {
            const token = randomBytes(18).toString('base64url');
            const review: Review = { sessionId, run, text };
            const key = `review:${token}`;
            enqueue(key, text);
            const buttonKey = `${key}:decision`;
            enqueue(buttonKey, 'Decisión sobre la acción mostrada arriba:', { inline_keyboard: [[
              { text: 'Aprobar', callback_data: `a:${token}` }, { text: 'Rechazar', callback_data: `d:${token}` }
            ]] });
            store.run('INSERT INTO reviews VALUES(?,?,?,?,0)', token, JSON.stringify(review), `${buttonKey}:0`, Math.min(...run.approvals.map(a => a.expiresAt)));
          }
        } else enqueue(`input:${row.id}`, `Estado: ${run.status}\n${run.output || '(Sin respuesta de texto)'}`.slice(0, 24_000));
        store.run("UPDATE inbox SET status='done' WHERE id=?", row.id);
      });
    };
    const ensureSession = async () => {
      const existing = store.meta('sessionId'); if (existing) return existing;
      let title = store.meta('sessionTitle');
      if (!title) { title = `Telegram ${randomBytes(16).toString('hex')}`; store.set('sessionTitle', title); }
      const listed = await command({ method: 'session.list', search: title });
      if (listed.kind !== 'sessions') throw new Error('SESSION_RESPONSE_INVALID');
      const matches = listed.sessions.filter(s => s.title === title);
      if (matches.length > 1) throw new Error('TELEGRAM_SESSION_AMBIGUOUS');
      let session = matches[0];
      if (!session) { const created = await command({ method: 'session.create', title, idempotencyKey: `tg-session-${hash(title).slice(0, 40)}` });
        if (created.kind !== 'session') throw new Error('SESSION_RESPONSE_INVALID'); session = created.session; }
      store.set('sessionId', session.sessionId); return session.sessionId;
    };
    const reconcile = async (row: Inbox) => {
      if (!row.intent) { finish(row, 'La tarea quedó interrumpida antes de registrar su ejecución. Reenviá tu solicitud si todavía la necesitás.'); return; }
      const intent = JSON.parse(row.intent) as Intent;
      let runId = 'runId' in intent.command ? intent.command.runId : undefined;
      if (!runId) {
        const session = await getSession(intent.sessionId);
        const candidates = session.runs.filter(r => !intent.priorRuns?.includes(r.runId));
        if (candidates.length === 1) runId = candidates[0]!.runId;
      }
      if (runId) {
        const current = await getRun(intent.sessionId, runId);
        if (['completed', 'failed', 'cancelled', 'timed_out', 'waiting_approval'].includes(current.run.status)) {
          await present(row, intent.sessionId, runId); return;
        }
      }
      finish(row, 'La ejecución quedó incierta tras una interrupción. No la repetí. Usá /pending para consultar su estado o /cancel para detenerla.');
    };
    const execute = async (row: Inbox, intent: Intent) => {
      store.run("UPDATE inbox SET status='processing', intent=? WHERE id=?", JSON.stringify(intent), row.id);
      const response = await client.command(intent.command);
      if (!response.ok) { finish(row, `Harness informó ${response.error.code}. Usá /pending para revisar el estado actual.`); return; }
      if (response.data.kind !== 'run') throw new Error('RUN_RESPONSE_INVALID');
      await present(row, intent.sessionId, response.data.run.runId);
    };
    const authenticate = (update: TelegramUpdate) => {
      const user = update.message?.from ?? update.callback_query?.from;
      const msg = update.message ?? update.callback_query?.message;
      return user && !user.is_bot && msg?.chat.type === 'private' &&
        String(user.id) === options.expectedTelegramUserId && String(msg.chat.id) === options.expectedTelegramUserId;
    };
    const ingest = (values: unknown[]) => {
      store.transaction(() => {
        for (const value of values) {
          const id = (value as { update_id?: unknown })?.update_id;
          if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw new Error('TELEGRAM_UPDATE_INVALID');
          const parsed = updateSchema.safeParse(value);
          if (parsed.success && authenticate(parsed.data)) {
            const row = parsed.data;
            // Before linking, only the locally-issued single-use challenge is accepted.
            if (!store.meta('chatId')) {
              if (row.message?.text === `/start ${pairingCode}` && pairingCode && now() <= Number(store.meta('pairExpires')) && hash(pairingCode) === store.meta('pairHash')) {
                store.set('chatId', options.expectedTelegramUserId); store.set('pairHash', 'used');
                store.run("INSERT OR IGNORE INTO inbox(id,payload,status) VALUES(?,?,'done')", id, JSON.stringify({ ...row, message: { ...row.message, text: '/start [linked]' } }));
                enqueue('paired', 'Propietario vinculado. Podés conversar conmigo. Comandos: /pending, /cancel, /help.');
              }
            } else if (!store.get('SELECT id FROM inbox WHERE id=?', id)) {
              if (store.get<{ n: number }>('SELECT COUNT(*) n FROM inbox')!.n >= 100_000) throw new Error('TELEGRAM_INBOX_CAPACITY');
              store.run('INSERT INTO inbox(id,payload) VALUES(?,?)', id, JSON.stringify(row));
            }
          }
          // Commit cursor with entries, including ignored/unauthorized updates.
          store.set('offset', String(Math.max(Number(store.meta('offset') ?? 0), id + 1)));
        }
      });
    };
    const processRow = async (row: Inbox) => {
      if (row.status === 'processing') { await reconcile(row); return; }
      const update = updateSchema.parse(JSON.parse(row.payload));
      if (!authenticate(update) || !store.meta('chatId')) { store.run("UPDATE inbox SET status='done' WHERE id=?", row.id); return; }
      const callback = update.callback_query;
      if (callback) {
        try { await options.api.call('answerCallbackQuery', { callback_query_id: callback.id }); } catch { /* Acknowledgement is best-effort, never authority. */ }
        const match = /^([ad]):([A-Za-z0-9_-]{24})$/.exec(callback.data ?? '');
        const found = match ? store.get<{ snapshot: string; delivery_id: string; expires: number; used: number }>('SELECT * FROM reviews WHERE token=?', match[2]!) : undefined;
        const sent = found ? store.get<Outbox>('SELECT * FROM outbox WHERE id=?', found.delivery_id) : undefined;
        if (!found || found.used || found.expires < now() || sent?.status !== 'sent' || sent.message_id !== callback.message?.message_id) {
          finish(row, 'Este botón no es válido, ya se usó o venció. Usá /pending para revisar la acción actual.'); return;
        }
        const review = JSON.parse(found.snapshot) as Review;
        const current = await getRun(review.sessionId, review.run.runId);
        if (current.run.status !== 'waiting_approval' || await reviewText(current.run) !== review.text) {
          finish(row, 'La acción cambió desde la revisión. Usá /pending para verla de nuevo.'); return;
        }
        const intent: Intent = { sessionId: review.sessionId, command: { method: 'approval.resolve', sessionId: review.sessionId,
          runId: review.run.runId, expectedRevision: review.run.revision, idempotencyKey: `tg-decision-${match![2]}`,
          decisions: review.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: match![1] === 'a' })) } };
        store.transaction(() => {
          store.run('UPDATE reviews SET used=1 WHERE token=?', match![2]!);
          store.run("UPDATE inbox SET status='processing', intent=? WHERE id=?", JSON.stringify(intent), row.id);
        });
        await execute(row, intent); return;
      }
      const text = update.message?.text;
      if (!text) { finish(row, 'Por ahora solo puedo recibir texto; no descargué el adjunto.'); return; }
      if (/^\/(daily|memory)(?:\s|$)/.test(text)) {
        store.transaction(() => {
          const response = scheduler ? scheduler.command(text, row.id) : 'El host necesita Calendar para configurar el resumen y sus preferencias.';
          enqueue(`input:${row.id}`, response); store.run("UPDATE inbox SET status='done' WHERE id=?", row.id);
        }); return;
      }
      if (text === '/help' || text.startsWith('/start')) { finish(row, 'Comandos: /pending muestra la última ejecución; /cancel la cancela. Las acciones se autorizan únicamente con sus botones de revisión. ' + automationHelp); return; }
      const sessionId = await ensureSession();
      const session = await getSession(sessionId);
      const latest = session.runs.at(-1);
      if (text === '/pending') {
        if (latest) await present(row, sessionId, latest.runId); else finish(row, 'No hay ejecuciones pendientes.'); return;
      }
      if (text === '/cancel') {
        if (!latest) { finish(row, 'No hay ejecución para cancelar.'); return; }
        const current = await getRun(sessionId, latest.runId);
        await execute(row, { sessionId, command: { method: 'run.cancel', sessionId, runId: latest.runId,
          expectedRevision: current.run.revision, idempotencyKey: `tg-cancel-${row.id}` } }); return;
      }
      if (text.startsWith('/')) { finish(row, 'Comando desconocido. Usá /help.'); return; }
      if (latest && !['completed', 'failed', 'cancelled', 'timed_out'].includes(latest.status)) {
        finish(row, 'Hay una ejecución activa o una decisión pendiente. Usá /pending o /cancel antes de iniciar otra tarea.'); return;
      }
      await execute(row, { sessionId, priorRuns: session.runs.map(r => r.runId), command: {
        method: 'run.start', sessionId, expectedRevision: session.revision, idempotencyKey: `tg-message-${row.id}`, prompt: text
      } });
    };
    let working = false, controls = false, flushing = false;
    let lastFault: string | undefined;
    const work = async (controlOnly = false) => {
      if (controlOnly ? controls : working) return;
      if (controlOnly) controls = true; else working = true;
      try {
        const rows = store.all<Inbox>("SELECT * FROM inbox WHERE status IN ('pending','processing') ORDER BY id LIMIT 100");
        for (const row of rows) {
          if (controller.signal.aborted) break;
          const text = (JSON.parse(row.payload) as TelegramUpdate).message?.text;
          if ((text === '/cancel') !== controlOnly) continue;
          try { await processRow(row); } catch { lastFault = 'INPUT_PROCESSING_FAILED'; /* Reconcile the persisted intent before retrying. */ break; }
        }
      } finally { if (controlOnly) controls = false; else working = false; }
    };
    const flush = async () => {
      if (flushing) return; flushing = true;
      try {
        for (const row of store.all<Outbox>("SELECT * FROM outbox WHERE status IN ('pending','retry') ORDER BY sequence LIMIT 100")) {
          if (controller.signal.aborted) break;
          if (row.expires_at !== null && row.expires_at <= now()) { store.run("UPDATE outbox SET status='expired' WHERE id=?", row.id); continue; }
          if (row.next_at > now()) break;
          // A review button is only sent after all preceding review chunks are confirmed.
          if (row.id.includes(':decision:')) {
            const prefix = row.id.split(':decision:')[0]!;
            const earlier = store.all<{ status: string }>('SELECT status FROM outbox WHERE substr(id,1,?)=? AND id<>?', prefix.length + 1, `${prefix}:`, row.id);
            if (earlier.some(r => ['failed', 'uncertain'].includes(r.status))) { store.run("UPDATE outbox SET status='failed' WHERE id=?", row.id); continue; }
            if (!earlier.length || earlier.some(r => r.status !== 'sent')) break;
          }
          store.run("UPDATE outbox SET status='sending', attempts=attempts+1 WHERE id=?", row.id);
          try {
            const result = await options.api.call('sendMessage', JSON.parse(row.payload)) as { message_id?: number; chat?: { id?: number } };
            if (!Number.isSafeInteger(result.message_id) || String(result.chat?.id) !== store.meta('chatId')) throw new TelegramFailure('uncertain');
            store.run("UPDATE outbox SET status='sent', message_id=? WHERE id=?", result.message_id!, row.id);
          } catch (error) {
            if (error instanceof TelegramFailure && error.kind === 'retry' && row.attempts < 4) {
              store.run("UPDATE outbox SET status='retry', next_at=? WHERE id=?", now() + error.retryAfter, row.id); break;
            }
            const status = error instanceof TelegramFailure && ['rejected', 'retry'].includes(error.kind) ? 'failed' : 'uncertain';
            store.run('UPDATE outbox SET status=? WHERE id=?', status, row.id);
          }
        }
      } finally { flushing = false; }
    };
    const controller = new AbortController(); let loop: Promise<void> | undefined;
    const delay = (ms = 1000) => new Promise<void>(resolve => { if (controller.signal.aborted) return resolve();
      const end = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', end); resolve(); };
      const timer = setTimeout(end, Math.min(ms, 2_147_483_647)); controller.signal.addEventListener('abort', end, { once: true }); });
    return {
      automation: scheduler ? { status: scheduler.status, command(text: string) {
        if (!store.meta('chatId')) throw new Error('TELEGRAM_NOT_LINKED');
        return store.transaction(() => scheduler.command(text, `web-owner:${randomBytes(12).toString('hex')}`));
      } } : undefined,
      pairingCode, ingest, work, flush, tick: () => scheduler?.tick() ?? Promise.resolve(),
      diagnostics: () => ({ linked: Boolean(store.meta('chatId')), offset: Number(store.meta('offset') ?? 0),
        inbox: store.all<{ status: string; count: number }>('SELECT status,COUNT(*) count FROM inbox GROUP BY status'),
        automation: scheduler?.status(), lastFault, outbox: store.all<{ status: string; count: number }>('SELECT status,COUNT(*) count FROM outbox GROUP BY status') }),
      start() {
        if (loop) return;
        const poll = async () => { while (!controller.signal.aborted) {
          try { const updates = await options.api.call('getUpdates', { offset: Number(store.meta('offset') ?? 0), timeout: 25,
            limit: 100, allowed_updates: ['message', 'callback_query'] }, controller.signal);
            if (!Array.isArray(updates) || updates.length > 100) throw new Error('TELEGRAM_UPDATES_INVALID'); ingest(updates);
          } catch (error) { lastFault = error instanceof TelegramFailure ? error.message : 'POLL_FAILED';
            if (!controller.signal.aborted) await delay(error instanceof TelegramFailure && error.kind === 'retry' ? error.retryAfter : 5000); }
        } };
        const worker = async (control: boolean) => { while (!controller.signal.aborted) { await work(control); await delay(); } };
        const deliveries = async () => { while (!controller.signal.aborted) { await flush(); await delay(); } };
        const schedules = async () => { while (!controller.signal.aborted) {
          try { await scheduler?.tick(); } catch { lastFault = 'AUTOMATION_TICK_FAILED'; }
          await delay(30_000);
        } };
        loop = Promise.all([poll(), worker(false), worker(true), deliveries(), schedules()].map(operation => operation.catch(() => {
          lastFault = 'CHANNEL_STOPPED'; controller.abort();
        }))).then(() => {});
      },
      async close() { controller.abort(); await scheduler?.close(); await loop; await store.close(); }
    };
  } catch (error) { await store.close(); throw error; }
}
