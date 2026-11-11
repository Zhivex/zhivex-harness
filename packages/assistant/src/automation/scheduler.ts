import type { TelegramStore } from '../telegram/store.js';
import { dailySummary, type AgendaSource } from './summary.js';
import { localDate, dayWindow, nextDaily, validZone } from './time.js';

type Preferences = { timeZone: string; localTime: string; calendarId: string; conflictBufferMinutes: number };
type Schedule = { enabled: number; revision: number; next_at: number };
type Occurrence = { id: string; day: string; revision: number; status: string; attempts: number; retry_at: number };
const keys = ['timeZone', 'localTime', 'calendarId', 'conflictBufferMinutes'] as const;
export const automationHelp = '/daily HH:mm Zona/IANA activa el resumen diario; /daily status|pause|resume|delete. /memory list; /memory set timeZone|localTime|calendarId|conflictBufferMinutes VALOR; /memory forget CLAVE|all.';

/** Runs inside the Telegram store/owner lease. Only the authenticated command lane may call command(). */
export function createDailyScheduler(store: TelegramStore, source: AgendaSource, enqueue: (key: string, text: string, expiresAt: number) => void, now: () => number = Date.now) {
  store.run('CREATE TABLE IF NOT EXISTS personal_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  store.run('CREATE TABLE IF NOT EXISTS daily_schedule(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,revision INTEGER NOT NULL,next_at INTEGER NOT NULL)');
  store.run('CREATE TABLE IF NOT EXISTS daily_occurrences(id TEXT PRIMARY KEY,day TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0)');
  if (store.meta('dailySchema') && store.meta('dailySchema') !== '1') throw new Error('AUTOMATION_SCHEMA_UNSUPPORTED');
  if (store.meta('dailyBinding') && store.meta('dailyBinding') !== source.binding) throw new Error('AUTOMATION_BINDING_MISMATCH');
  store.set('dailySchema', '1'); store.set('dailyBinding', source.binding);
  store.run("UPDATE daily_occurrences SET status='pending' WHERE status='building'");
  const schedule = () => store.get<Schedule>('SELECT * FROM daily_schedule WHERE id=1');
  const preferences = (): Preferences | undefined => {
    const rows = store.all<{ key: string; value: string }>('SELECT key,value FROM personal_preferences');
    const values = Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)]));
    if (keys.some(key => values[key] === undefined)) return;
    if (!validZone(values.timeZone) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.localTime) || values.calendarId !== source.calendarId ||
      !Number.isInteger(values.conflictBufferMinutes) || values.conflictBufferMinutes < 0 || values.conflictBufferMinutes > 120) throw new Error('AUTOMATION_PREFERENCES_INVALID');
    return values as Preferences;
  };
  const cancel = () => {
    store.run("UPDATE daily_occurrences SET status='cancelled' WHERE status IN ('pending','building')");
    store.run("UPDATE outbox SET status='cancelled' WHERE substr(id,1,6)='daily:' AND status IN ('pending','retry')");
  };
  const save = (key: string, value: string | number, updateId: number | string) => store.run(
    'INSERT INTO personal_preferences VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,updated_at=excluded.updated_at',
    key, JSON.stringify(value), typeof updateId === 'number' ? `telegram-owner:${updateId}` : updateId, now());
  const reschedule = (enabled: boolean) => {
    cancel(); const prefs = preferences();
    if (enabled && !prefs) throw new Error('AUTOMATION_PREFERENCES_REQUIRED');
    store.run('INSERT INTO daily_schedule VALUES(1,?,1,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,revision=daily_schedule.revision+1,next_at=excluded.next_at',
      enabled ? 1 : 0, prefs ? nextDaily(now(), prefs.timeZone, prefs.localTime) : 0);
  };
  let flight: Promise<void> | undefined, stopped = false;
  const controller = new AbortController();
  const status = () => ({ schedule: schedule() ?? null, preferences: store.all('SELECT key,value,source,updated_at FROM personal_preferences ORDER BY key'),
    occurrences: store.all('SELECT id,day,status,attempts FROM daily_occurrences ORDER BY day DESC LIMIT 7') });
  const command = (text: string, updateId: number | string): string => {
    const args = text.trim().split(/\s+/);
    if (args[0] === '/memory') {
      if (args[1] === 'list' && args.length === 2) {
        const rows = store.all<{ key: string; value: string; source: string }>('SELECT key,value,source FROM personal_preferences ORDER BY key');
        return rows.length ? rows.map(row => `${row.key}: ${JSON.parse(row.value)} (guardada por tu comando ${row.source})`).join('\n') : 'No hay preferencias guardadas.';
      }
      if (args[1] === 'forget' && args.length === 3 && (args[2] === 'all' || keys.includes(args[2] as typeof keys[number]))) {
        if (args[2] === 'all') store.run('DELETE FROM personal_preferences'); else store.run('DELETE FROM personal_preferences WHERE key=?', args[2]!);
        reschedule(false); return 'Preferencia olvidada. Resumen pausado; configurá las preferencias faltantes antes de reanudar. Los mensajes ya enviados y el historial de conversación no se borran.';
      }
      if (args[1] === 'set' && args.length === 4 && keys.includes(args[2] as typeof keys[number])) {
        const key = args[2]!, raw = args[3]!;
        const value = key === 'conflictBufferMinutes' && /^\d{1,3}$/.test(raw) ? Number(raw) : raw;
        const valid = key === 'timeZone' ? validZone(raw) : key === 'localTime' ? /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw) :
          key === 'calendarId' ? raw === source.calendarId : typeof value === 'number' && value <= 120;
        if (!valid) return 'Preferencia inválida. El calendario debe coincidir con la conexión del host; el margen admite 0–120 minutos.';
        save(key, value, updateId); reschedule(Boolean(schedule()?.enabled));
        return 'Preferencia guardada con procedencia del propietario. No otorga permisos ni activa una automatización pausada.';
      }
      return automationHelp;
    }
    if (args[0] !== '/daily') return automationHelp;
    if (args[1] === 'status' && args.length === 2) {
      const current = schedule(), prefs = preferences();
      if (!current) return 'No hay un resumen diario configurado.';
      const next = current.enabled && prefs ? new Intl.DateTimeFormat('es', { timeZone: prefs.timeZone, dateStyle: 'full', timeStyle: 'short' }).format(current.next_at) + ` (${prefs.timeZone})` : 'sin próxima ejecución';
      const states: Record<string, string> = { pending: 'pendiente', building: 'leyendo agenda', enqueued: 'resumen preparado', cancelled: 'cancelado', skipped: 'omitido', failed: 'lectura fallida' };
      const recent = store.all<{ day: string; status: string }>('SELECT day,status FROM daily_occurrences ORDER BY day DESC LIMIT 3');
      const deliveries = store.all<{ status: string; n: number }>("SELECT status,COUNT(*) n FROM outbox WHERE substr(id,1,6)='daily:' GROUP BY status");
      const deliveryLabels: Record<string, string> = { pending: 'pendientes', retry: 'en reintento', sending: 'enviando', sent: 'enviados', uncertain: 'inciertos (sin reenvío)', failed: 'fallidos', expired: 'vencidos', cancelled: 'cancelados' };
      return [`Resumen ${current.enabled ? 'activo' : 'pausado'}. Próximo: ${next}.`, ...recent.map(row => `${row.day}: ${states[row.status] ?? row.status}`),
        'Fragmentos de resúmenes: ' + (deliveries.map(row => `${row.n} ${deliveryLabels[row.status] ?? row.status}`).join(', ') || 'ninguno')].join('\n');
    }
    if (args[1] === 'pause' && args.length === 2) { reschedule(false); return 'Resumen diario pausado. Entregas pendientes canceladas; un envío ya iniciado no se puede retirar.'; }
    if (args[1] === 'delete' && args.length === 2) { cancel(); store.run('DELETE FROM daily_schedule'); return 'Automatización eliminada. Preferencias conservadas; /memory forget all las olvida.'; }
    if (args[1] === 'resume' && args.length === 2) {
      if (!preferences()) return 'Faltan preferencias. Usá /daily HH:mm Zona/IANA para configurarlas.';
      reschedule(true); return 'Resumen diario reanudado para el próximo horario local.';
    }
    if (args.length === 3 && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(args[1]!) && validZone(args[2]!)) {
      save('localTime', args[1]!, updateId); save('timeZone', args[2]!, updateId); save('calendarId', source.calendarId, updateId);
      if (!store.get("SELECT key FROM personal_preferences WHERE key='conflictBufferMinutes'")) save('conflictBufferMinutes', 0, updateId);
      reschedule(true);
      return `Resumen diario activado a las ${args[1]} (${args[2]}), desde el próximo horario. Solo lectura de ${source.calendarId}. Días anteriores omitidos; se recupera el día actual. Margen de conflicto: ${preferences()!.conflictBufferMinutes} minutos.`;
    }
    return automationHelp;
  };
  const run = async () => {
    if (stopped || !store.meta('chatId')) return;
    const settings = schedule(), prefs = preferences(); if (!settings?.enabled || !prefs) return;
    const today = localDate(now(), prefs.timeZone), window = dayWindow(today, prefs.timeZone, prefs.localTime);
    store.transaction(() => {
      store.run("UPDATE daily_occurrences SET status='skipped' WHERE status IN ('pending','building') AND day<>?", today);
      if (settings.next_at <= now()) {
        store.run('UPDATE daily_schedule SET next_at=? WHERE id=1', nextDaily(now(), prefs.timeZone, prefs.localTime));
        // One occurrence per local date, and at least 20 hours between admissions across timezone/config changes.
        const last = Number(store.meta('dailyLastAdmission') ?? 0);
        if (window && window.due <= now() && now() - last >= 20 * 3600_000) {
          if (store.get<{ n: number }>('SELECT COUNT(*) n FROM daily_occurrences')!.n >= 3660) throw new Error('AUTOMATION_CAPACITY');
          const inserted = store.run("INSERT OR IGNORE INTO daily_occurrences(id,day,revision,status) VALUES(?,?,?,'pending')", `daily:${today}`, today, settings.revision);
          if (Number(inserted.changes)) store.set('dailyLastAdmission', String(now()));
        }
      }
    });
    const occurrence = store.get<Occurrence>("SELECT * FROM daily_occurrences WHERE status='pending' AND day=? AND retry_at<=?", today, now());
    if (!occurrence || occurrence.revision !== settings.revision || !window || window.due > now()) return;
    const failedRead = () => store.transaction(() => {
      const current = schedule();
      if (!current?.enabled || current.revision !== settings.revision || localDate(now(), prefs.timeZone) !== today ||
        !['pending','building'].includes(store.get<{ status: string }>('SELECT status FROM daily_occurrences WHERE id=?', occurrence.id)?.status ?? '')) return;
      const exhausted = occurrence.attempts >= 2;
      store.run("UPDATE daily_occurrences SET status=?,retry_at=? WHERE id=?", exhausted ? 'failed' : 'pending', now() + 5 * 60_000, occurrence.id);
      if (exhausted) enqueue(occurrence.id, `No pude obtener la agenda completa del ${today}. Revisá la conexión de Calendar. No puedo afirmar que no haya conflictos.`, window!.end);
    });
    if (occurrence.attempts >= 3) { failedRead(); return; }
    store.run("UPDATE daily_occurrences SET status='building',attempts=attempts+1 WHERE id=?", occurrence.id);
    let body: string;
    try { body = await dailySummary(source, today, prefs.timeZone, prefs.conflictBufferMinutes, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])); }
    catch {
      if (stopped) return; // startup safely retries a read interrupted by shutdown
      failedRead();
      return;
    }
    if (stopped) return;
    store.transaction(() => {
      const current = schedule();
      if (!current?.enabled || current.revision !== settings.revision || localDate(now(), prefs.timeZone) !== today ||
        store.get<{ status: string }>('SELECT status FROM daily_occurrences WHERE id=?', occurrence.id)?.status !== 'building') return;
      enqueue(occurrence.id, body, window!.end);
      store.run("UPDATE daily_occurrences SET status='enqueued' WHERE id=?", occurrence.id);
    });
  };
  return { command, status,
    tick() { if (stopped) return Promise.resolve(); return flight ??= run().finally(() => { flight = undefined; }); },
    async close() { stopped = true; controller.abort(); await flight; }
  };
}
