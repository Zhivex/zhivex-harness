import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TelegramStore } from '../telegram/store.js';
import type { NotificationDelivery } from '../daily/service.js';
import type { AgendaSource, AgendaEvent } from '../automation/summary.js';
import { addDay, dayWindow, localDate, validZone } from '../automation/time.js';
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const proactivePolicySchema = z.strictObject({
  enabled: z.boolean(),
  timeZone: z.string().max(100).refine(validZone),
  channel: z.enum(['web', 'telegram']),
  calendar: z.boolean().default(true),
  tasks: z.boolean().default(true),
  replies: z.boolean().default(true),
  quietStart: clock.default('22:00'),
  quietEnd: clock.default('08:00'),
  maxPerDay: z.number().int().min(1).max(20).default(5),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
});
export const watchReplySchema = z.strictObject({
  requestId: z.string().uuid(),
  source: z.enum(['google', 'microsoft']),
  threadId: z.string().min(1).max(1024),
  baselineMessageId: z.string().min(1).max(1024),
  expectedFrom: z.email().max(254),
  title: z.string().trim().min(1).max(300),
  dueAt: z.iso.datetime({ offset: true }),
});
export const cancelWatchSchema = z.strictObject({ watchId: z.string().uuid() });
export interface ReplySource {
  id: string;
  binding: string;
  read(
    threadId: string,
    signal: AbortSignal,
  ): Promise<{
    complete: boolean;
    messages: {
      id: string;
      from: string;
      at: number;
      draft: boolean;
    }[];
  }>;
}
type Policy = z.infer<typeof proactivePolicySchema>;
type Watch = {
  id: string;
  source: string;
  binding: string;
  thread_id: string;
  baseline_id: string;
  expected_from: string;
  title: string;
  due_at: number;
  status: string;
};
type Alert = {
  id: string;
  kind: string;
  text: string;
  status: string;
  created_at: number;
  expires_at: number;
  channel: string;
};
type Candidate = {
  id: string;
  kind: string;
  text: string;
  expires: number;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 300);
export function mailbox(value: string) {
  return (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase();
}
/** Deterministic read-only detectors. Owns no external write capability. Shares the daily store lease. */
export function createProactiveService(store: TelegramStore, now = Date.now) {
  if (store.meta('proactiveSchema') && store.meta('proactiveSchema') !== '1')
    throw new Error('PROACTIVE_SCHEMA_UNSUPPORTED');
  store.set('proactiveSchema', '1');
  store.run(
    'CREATE TABLE IF NOT EXISTS proactive_alerts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,channel TEXT NOT NULL)',
  );
  store.run(
    'CREATE TABLE IF NOT EXISTS reply_watches(id TEXT PRIMARY KEY,digest TEXT NOT NULL,source TEXT NOT NULL,binding TEXT NOT NULL,thread_id TEXT NOT NULL,baseline_id TEXT NOT NULL,expected_from TEXT NOT NULL,title TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL)',
  );
  store.run('CREATE INDEX IF NOT EXISTS proactive_alerts_created ON proactive_alerts(created_at)');
  store.run('CREATE INDEX IF NOT EXISTS reply_watches_due ON reply_watches(status,due_at)');
  store.run("UPDATE proactive_alerts SET status='uncertain' WHERE status='sending'");
  let agenda: AgendaSource | undefined,
    sources: ReplySource[] = [],
    delivery: NotificationDelivery | undefined;
  let stopped = false,
    flight: Promise<void> | undefined,
    revision = 0;
  const controller = new AbortController();
  const policy = (): Policy | null => {
    const value = store.meta('proactivePolicy');
    return value ? proactivePolicySchema.parse(JSON.parse(value)) : null;
  };
  const quiet = (p: Policy) => {
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: p.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(now());
    return p.quietStart === p.quietEnd
      ? false
      : p.quietStart < p.quietEnd
        ? time >= p.quietStart && time < p.quietEnd
        : time >= p.quietStart || time < p.quietEnd;
  };
  const live = (r: number) => !stopped && revision === r && policy()?.enabled === true;
  const fault = (source: string, failed: boolean) =>
    store.set(
      `proactiveHealth:${source}`,
      JSON.stringify({ status: failed ? 'unavailable' : 'ok', checkedAt: now() }),
    );
  const publish = async (candidate: Candidate, p: Policy, r: number) => {
    if (
      !live(r) ||
      quiet(p) ||
      candidate.expires <= now() ||
      (p.channel === 'telegram' && !delivery?.ready())
    )
      return;
    const window = dayWindow(localDate(now(), p.timeZone), p.timeZone)!;
    const admitted = store.transaction(() => {
      if (store.get('SELECT id FROM proactive_alerts WHERE id=?', candidate.id)) return false;
      // Rolling bound additionally prevents bursts when changing timezone or crossing midnight.
      const count = store.get<{
        n: number;
      }>(
        'SELECT COUNT(*) n FROM proactive_alerts WHERE created_at>=?',
        Math.min(window.start, now() - 86400000),
      )!.n;
      if (count >= p.maxPerDay) return false;
      if (
        store.get<{
          n: number;
        }>('SELECT COUNT(*) n FROM proactive_alerts')!.n >= 10000
      )
        throw new Error('PROACTIVE_CAPACITY');
      store.run(
        'INSERT INTO proactive_alerts VALUES(?,?,?,?,?,?,?)',
        candidate.id,
        candidate.kind,
        candidate.text,
        p.channel === 'web' ? 'available' : 'sending',
        now(),
        candidate.expires,
        p.channel,
      );
      return true;
    });
    if (!admitted || p.channel === 'web') return;
    try {
      await delivery!.send(
        candidate.text,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      store.run("UPDATE proactive_alerts SET status='delivered' WHERE id=?", candidate.id);
    } catch {
      store.run("UPDATE proactive_alerts SET status='uncertain' WHERE id=?", candidate.id);
    }
  };
  const calendarCandidates = async (p: Policy, signal: AbortSignal): Promise<Candidate[]> => {
    if (!agenda) throw new Error('PROACTIVE_CALENDAR_UNAVAILABLE');
    const events: AgendaEvent[] = [],
      tokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      const result = await agenda.list(
        {
          timeMin: new Date(now()).toISOString(),
          timeMax: new Date(now() + 86400000).toISOString(),
          ...(pageToken ? { pageToken } : {}),
        },
        signal,
      );
      if (result.events.length > 100) throw new Error('PROACTIVE_CALENDAR_INCOMPLETE');
      events.push(...result.events);
      if (result.complete && !result.nextPageToken) break;
      if (!result.nextPageToken || tokens.has(result.nextPageToken) || page >= 9)
        throw new Error('PROACTIVE_CALENDAR_INCOMPLETE');
      pageToken = result.nextPageToken;
      tokens.add(pageToken);
    }
    const instant = (v: AgendaEvent['start']) =>
      v.dateTime
        ? Date.parse(v.dateTime)
        : v.date
          ? dayWindow(v.date, p.timeZone)?.start
          : undefined;
    const busy = [...new Map(events.map((e) => [e.id, e])).values()]
      .filter((e) => e.status !== 'cancelled' && e.busy !== false)
      .map((e) => {
        const start = instant(e.start),
          end = instant(e.end);
        if (
          start === undefined ||
          end === undefined ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start
        )
          throw new Error('PROACTIVE_CALENDAR_INVALID');
        return { ...e, from: start, to: end };
      })
      .filter((e) => e.to > now())
      .sort((a, b) => a.from - b.from || a.id.localeCompare(b.id));
    const candidates: Candidate[] = [];
    const format = new Intl.DateTimeFormat('es', {
      timeZone: p.timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    for (let i = 0; i < busy.length; i++)
      for (let j = i + 1; j < busy.length; j++) {
        const a = busy[i]!,
          b = busy[j]!;
        if (b.from >= a.to + p.bufferMinutes * 60000) break;
        candidates.push({
          id: digest([
            'calendar',
            agenda.binding,
            [a.id, a.from, a.to],
            [b.id, b.from, b.to],
            p.bufferMinutes,
          ]),
          kind: 'calendar',
          expires: Math.min(a.to, b.to),
          text: `Conflicto de agenda · ${p.timeZone}\n${safe(a.summary)} (${format.format(a.from)}) ↔ ${safe(b.summary)} (${format.format(b.from)}).\nSe superponen o no respetan tu margen de ${p.bufferMinutes} minutos. Pedime revisar horarios alternativos; cualquier cambio requiere tu aprobación.`,
        });
        if (candidates.length >= 100) return candidates;
      }
    return candidates;
  };
  const run = async () => {
    if (stopped) return;
    store.run(
      "UPDATE proactive_alerts SET status='expired' WHERE status='available' AND expires_at<=?",
      now(),
    );
    const p = policy();
    if (!p?.enabled) return;
    if (Number(store.meta('proactiveNextAt') ?? 0) > now()) return;
    store.set('proactiveNextAt', String(now() + 5 * 60000));
    const r = revision,
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
    if (p.calendar) {
      try {
        const candidates = await calendarCandidates(p, signal);
        if (!live(r)) return;
        fault('calendar', false);
        const current = new Set(candidates.map((c) => c.id));
        for (const row of store.all<{
          id: string;
        }>("SELECT id FROM proactive_alerts WHERE kind='calendar' AND status='available'"))
          if (!current.has(row.id))
            store.run("UPDATE proactive_alerts SET status='resolved' WHERE id=?", row.id);
        for (const candidate of candidates) await publish(candidate, p, r);
      } catch {
        if (live(r)) fault('calendar', true);
      }
    }
    if (!live(r)) return;
    if (p.tasks) {
      const today = localDate(now(), p.timeZone),
        tomorrow = addDay(today);
      const tasks = store.all<{
        id: string;
        title: string;
        due_date: string;
      }>(
        "SELECT id,title,due_date FROM tasks WHERE status='pending' AND due_date<=? ORDER BY due_date,id",
        tomorrow,
      );
      const current = new Set(
        tasks.map((task) =>
          digest([
            'task',
            task.id,
            task.due_date,
            task.due_date < today
              ? 'vencida'
              : task.due_date === today
                ? 'vence hoy'
                : 'vence mañana',
          ]),
        ),
      );
      for (const row of store.all<{
        id: string;
      }>("SELECT id FROM proactive_alerts WHERE kind='task' AND status='available'"))
        if (!current.has(row.id))
          store.run("UPDATE proactive_alerts SET status='resolved' WHERE id=?", row.id);
      for (const task of tasks) {
        if (!live(r)) return;
        if (
          store.get<{
            status: string;
          }>('SELECT status FROM tasks WHERE id=?', task.id)?.status !== 'pending'
        )
          continue;
        const stage =
          task.due_date < today
            ? 'vencida'
            : task.due_date === today
              ? 'vence hoy'
              : 'vence mañana';
        await publish(
          {
            id: digest(['task', task.id, task.due_date, stage]),
            kind: 'task',
            expires: dayWindow(tomorrow, p.timeZone)!.start,
            text: `Tarea ${stage} · ${safe(task.title)}\nFecha: ${task.due_date} (${p.timeZone}). Pedime completarla o revisar tus pendientes.`,
          },
          p,
          r,
        );
      }
    }
    if (!p.replies || !live(r)) return;
    for (const watch of store.all<Watch>(
      "SELECT * FROM reply_watches WHERE status='waiting' ORDER BY due_at,id LIMIT 20",
    )) {
      if (!live(r)) return;
      try {
        const source = sources.find((s) => s.id === watch.source && s.binding === watch.binding);
        if (!source) throw new Error('PROACTIVE_REPLY_SOURCE_UNAVAILABLE');
        const thread = await source.read(watch.thread_id, signal);
        if (
          !live(r) ||
          store.get<{
            status: string;
          }>('SELECT status FROM reply_watches WHERE id=?', watch.id)?.status !== 'waiting'
        )
          continue;
        const baseline = thread.messages.find((m) => m.id === watch.baseline_id && !m.draft);
        if (!thread.complete || !baseline || !Number.isFinite(baseline.at))
          throw new Error('PROACTIVE_THREAD_INCOMPLETE');
        const replied = thread.messages.some(
          (m) =>
            !m.draft &&
            m.id !== baseline.id &&
            Number.isFinite(m.at) &&
            m.at > baseline.at &&
            mailbox(m.from) === watch.expected_from,
        );
        fault(`reply:${watch.id}`, false);
        if (replied) {
          store.run("UPDATE reply_watches SET status='replied' WHERE id=?", watch.id);
          store.run(
            "UPDATE proactive_alerts SET status='resolved' WHERE id=? AND status='available'",
            digest(['reply', watch.id]),
          );
        } else if (watch.due_at <= now())
          await publish(
            {
              id: digest(['reply', watch.id]),
              kind: 'reply',
              expires: now() + 86400000,
              text: `Respuesta pendiente · ${safe(watch.title)}\nNo encontré una respuesta posterior de ${safe(watch.expected_from)} en el hilo seguido (${watch.source}). Pedime revisar el hilo y preparar un borrador de seguimiento.`,
            },
            p,
            r,
          );
      } catch {
        if (live(r)) fault(`reply:${watch.id}`, true);
      }
    }
  };
  return {
    bind(input: { agenda?: AgendaSource; replies?: ReplySource[] }) {
      agenda = input.agenda;
      sources = input.replies ?? [];
      revision++;
    },
    setDelivery(value?: NotificationDelivery) {
      delivery = value;
    },
    configure(input: unknown) {
      const value = proactivePolicySchema.parse(input);
      if (value.enabled && value.channel === 'telegram' && !delivery?.ready())
        throw new Error('PROACTIVE_TELEGRAM_NOT_LINKED');
      revision++;
      if (!value.calendar) store.run("DELETE FROM meta WHERE key='proactiveHealth:calendar'");
      if (!value.replies) store.run("DELETE FROM meta WHERE key LIKE 'proactiveHealth:reply:%'");
      store.set('proactivePolicy', JSON.stringify(value));
      store.set('proactiveNextAt', '0');
      return value;
    },
    watch(input: unknown) {
      const args = watchReplySchema.parse(input),
        source = sources.find((s) => s.id === args.source);
      if (!source) throw new Error('PROACTIVE_REPLY_SOURCE_UNAVAILABLE');
      const hash = digest(args),
        previous = store.get<{
          digest: string;
        }>('SELECT digest FROM reply_watches WHERE id=?', args.requestId);
      if (previous) {
        if (previous.digest !== hash) throw new Error('PROACTIVE_REQUEST_CONFLICT');
        return { watchId: args.requestId };
      }
      if (
        store.get(
          "SELECT id FROM reply_watches WHERE source=? AND binding=? AND thread_id=? AND baseline_id=? AND expected_from=? AND status='waiting'",
          args.source,
          source.binding,
          args.threadId,
          args.baselineMessageId,
          mailbox(args.expectedFrom),
        )
      )
        throw new Error('PROACTIVE_WATCH_EXISTS');
      const due = Date.parse(args.dueAt);
      if (due <= now() || due > now() + 366 * 86400000) throw new Error('PROACTIVE_DUE_INVALID');
      if (
        store.get<{
          n: number;
        }>("SELECT COUNT(*) n FROM reply_watches WHERE status='waiting'")!.n >= 20 ||
        store.get<{
          n: number;
        }>('SELECT COUNT(*) n FROM reply_watches')!.n >= 10000
      )
        throw new Error('PROACTIVE_WATCH_CAPACITY');
      store.run(
        "INSERT INTO reply_watches VALUES(?,?,?,?,?,?,?,?,?,'waiting')",
        args.requestId,
        hash,
        args.source,
        source.binding,
        args.threadId,
        args.baselineMessageId,
        mailbox(args.expectedFrom),
        args.title,
        due,
      );
      return { watchId: args.requestId };
    },
    cancelWatch(input: unknown) {
      const { watchId } = cancelWatchSchema.parse(input);
      revision++;
      store.run('DELETE FROM meta WHERE key=?', `proactiveHealth:reply:${watchId}`);
      store.run(
        "UPDATE reply_watches SET status='cancelled' WHERE id=? AND status='waiting'",
        watchId,
      );
      store.run(
        "UPDATE proactive_alerts SET status='resolved' WHERE id=? AND status='available'",
        digest(['reply', watchId]),
      );
      return { watchId };
    },
    dismiss(input: unknown) {
      const { alertId } = z
        .strictObject({ alertId: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(input);
      store.run(
        "UPDATE proactive_alerts SET status='dismissed' WHERE id=? AND status='available'",
        alertId,
      );
      return { alertId };
    },
    status() {
      return {
        policy: policy(),
        sources: { calendar: Boolean(agenda), replies: sources.map((s) => s.id) },
        nextAt: Number(store.meta('proactiveNextAt') ?? 0),
        health: store
          .all<{
            key: string;
            value: string;
          }>("SELECT key,value FROM meta WHERE key LIKE 'proactiveHealth:%'")
          .map((row) => ({
            source: row.key.slice('proactiveHealth:'.length),
            ...JSON.parse(row.value),
          })),
        watches: store.all<Watch>(
          'SELECT id,source,binding,thread_id,baseline_id,expected_from,title,due_at,status FROM reply_watches ORDER BY due_at DESC LIMIT 100',
        ),
        alerts: store.all<Alert>(
          'SELECT * FROM proactive_alerts ORDER BY created_at DESC,id LIMIT 100',
        ),
      };
    },
    tick() {
      return (flight ??= run()
        .catch(() => {
          if (!stopped) fault('scheduler', true);
        })
        .finally(() => {
          flight = undefined;
        }));
    },
    async stop() {
      stopped = true;
      revision++;
      controller.abort();
      await flight;
    },
  };
}
