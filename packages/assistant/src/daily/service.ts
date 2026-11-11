import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { openTelegramStore } from '../telegram/store.js';
import { dayWindow, validZone } from '../automation/time.js';

export interface NotificationDelivery {
  ready(): boolean;
  send(text: string, signal: AbortSignal): Promise<void>;
}
export const requestId = z.string().uuid();
const title = z.string().trim().min(1).max(500);
export const reminderSchema = z.strictObject({ requestId, text: title, date: z.iso.date(),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string().max(100).refine(validZone), channel: z.enum(['web','telegram']) });
export type ReminderInput = z.infer<typeof reminderSchema>;
export const taskCreateSchema = z.strictObject({ requestId, title, dueDate: z.iso.date().optional() });
export const taskCompleteSchema = z.strictObject({ requestId, taskId: z.string().uuid() });
export const noteSaveSchema = z.strictObject({ requestId, title, text: z.string().min(1).max(16000) });
export const noteDeleteSchema = z.strictObject({ requestId, noteId: z.string().uuid() });
export const cancelReminderSchema = z.strictObject({ requestId, reminderId: z.string().uuid() });
export const pageSchema = z.strictObject({ offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(20) });
type Reminder = { id: string; text: string; due_at: number; time_zone: string; channel: string; status: string };

export async function openDailyService(directory: string, ownerId: string, recover = false, now = Date.now) {
  const root = path.join(directory, 'daily');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = await openTelegramStore(root, recover);
  try {
    if (store.meta('owner') && store.meta('owner') !== ownerId) throw new Error('DAILY_OWNER_MISMATCH');
    store.set('owner', ownerId);
    store.run('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,due_date TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL)');
    store.run('CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL)');
    store.run('CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,text TEXT NOT NULL,due_at INTEGER NOT NULL,time_zone TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL)');
    store.run('CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,due_at)');
    store.run('CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL)');
    store.run("UPDATE reminders SET status='uncertain' WHERE status='sending'");
    const once = (kind: string, input: { requestId: string }, effect: () => unknown) => store.transaction(() => {
      const digest = createHash('sha256').update(JSON.stringify({ kind, input })).digest('hex');
      const previous = store.get<{ digest: string; result: string }>('SELECT * FROM receipts WHERE id=?', input.requestId);
      if (previous) { if (previous.digest !== digest) throw new Error('DAILY_REQUEST_CONFLICT'); return JSON.parse(previous.result); }
      if (store.get<{ n: number }>('SELECT COUNT(*) n FROM receipts')!.n >= 10000) throw new Error('DAILY_CAPACITY');
      const result = effect(); store.run('INSERT INTO receipts VALUES(?,?,?)', input.requestId, digest, JSON.stringify(result)); return result;
    });
    const listTasks = (input: unknown = {}) => {
      const { offset, limit } = pageSchema.parse(input);
      const total = store.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE status='pending'")!.n;
      return { tasks: store.all("SELECT * FROM tasks WHERE status='pending' ORDER BY due_date IS NULL,due_date,created_at,id LIMIT ? OFFSET ?", limit, offset), total, nextOffset: offset + limit < total ? offset + limit : null };
    };
    const listReminders = () => store.all<Reminder>('SELECT * FROM reminders ORDER BY due_at DESC,id LIMIT 100');
    const due = (input: ReminderInput) => {
      const window = dayWindow(input.date, input.timeZone, input.localTime);
      if (!window) throw new Error('REMINDER_DATE_MISSING');
      return window.due;
    };
    let delivery: NotificationDelivery | undefined, timer: ReturnType<typeof setInterval> | undefined, flight: Promise<void> | undefined;
    let stopped = false;
    const controller = new AbortController();
    const tick = () => flight ??= (async () => {
      if (stopped) return;
      for (const row of store.all<Reminder>("SELECT * FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 50", now())) {
        if (stopped) break;
        // Late reminders expire instead of delivering a burst after a long outage.
        if (now() - row.due_at > 86400_000) { store.run("UPDATE reminders SET status='expired' WHERE id=?", row.id); continue; }
        if (row.channel === 'web') { store.run("UPDATE reminders SET status='available' WHERE id=? AND status='pending'", row.id); continue; }
        if (!delivery?.ready()) continue;
        const claimed = store.run("UPDATE reminders SET status='sending' WHERE id=? AND status='pending'", row.id);
        if (!Number(claimed.changes)) continue;
        try {
          await delivery.send(`Recordatorio · ${row.time_zone}\n${row.text}`, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
          store.run("UPDATE reminders SET status='delivered' WHERE id=?", row.id);
        } catch { store.run("UPDATE reminders SET status='uncertain' WHERE id=?", row.id); }
      }
    })().finally(() => { flight = undefined; });
    return {
      listTasks, listReminders, tick,
      start(notifications?: NotificationDelivery) { if (timer || stopped) return; delivery = notifications; timer = setInterval(() => { void tick().catch(() => {}); }, 1000); timer.unref(); },
      createTask(input: unknown) { const args = taskCreateSchema.parse(input); return once('task.create', args, () => {
        store.run("INSERT INTO tasks VALUES(?,?,?,'pending',?)", args.requestId, args.title, args.dueDate ?? null, now()); return { taskId: args.requestId, status: 'pending' };
      }); },
      completeTask(input: unknown) { const args = taskCompleteSchema.parse(input); return once('task.complete', args, () => {
        if (!store.get('SELECT id FROM tasks WHERE id=?', args.taskId)) throw new Error('TASK_NOT_FOUND');
        store.run("UPDATE tasks SET status='completed' WHERE id=?", args.taskId); return { taskId: args.taskId, status: 'completed' };
      }); },
      reminderReview(input: unknown) { const args = reminderSchema.parse(input); return { ...args, scheduledAt: new Date(due(args)).toISOString(), dstPolicy: 'first occurrence on folds; first existing minute after gaps', latePolicy: 'expires after 24 hours', delivery: args.channel === 'web' ? 'visible in the local web when the host runs' : 'paired private Telegram chat' }; },
      scheduleReminder(input: unknown) { const args = reminderSchema.parse(input); return once('reminder.schedule', args, () => {
        if (args.channel === 'telegram' && !delivery?.ready()) throw new Error('REMINDER_TELEGRAM_NOT_LINKED');
        const at = due(args);
        if (at <= now() || at > now() + 366 * 86400_000) throw new Error('REMINDER_TIME_INVALID');
        store.run("INSERT INTO reminders VALUES(?,?,?,?,?,'pending')", args.requestId, args.text, at, args.timeZone, args.channel);
        return { reminderId: args.requestId, scheduledAt: new Date(at).toISOString(), status: 'pending' };
      }); },
      cancelReminder(input: unknown) { const args = cancelReminderSchema.parse(input); return once('reminder.cancel', args, () => {
        const row = store.get<Reminder>('SELECT * FROM reminders WHERE id=?', args.reminderId);
        if (!row) throw new Error('REMINDER_NOT_FOUND');
        if (!['pending','available','cancelled'].includes(row.status)) throw new Error('REMINDER_ALREADY_DISPATCHED');
        store.run("UPDATE reminders SET status='cancelled' WHERE id=?", args.reminderId); return { reminderId: args.reminderId, status: 'cancelled' };
      }); },
      saveNote(input: unknown) { const args = noteSaveSchema.parse(input); return once('note.save', args, () => {
        store.run('INSERT INTO notes VALUES(?,?,?,?)', args.requestId, args.title, args.text, now()); return { noteId: args.requestId };
      }); },
      deleteNote(input: unknown) { const args = noteDeleteSchema.parse(input); return once('note.delete', args, () => { store.run('DELETE FROM notes WHERE id=?', args.noteId); return { deleted: true, noteId: args.noteId }; }); },
      searchNotes(input: unknown) {
        const args = pageSchema.extend({ query: z.string().min(1).max(200) }).parse(input);
        const total = store.get<{ n: number }>('SELECT COUNT(*) n FROM notes WHERE instr(lower(title || body),lower(?))>0', args.query)!.n;
        return { notes: store.all('SELECT id,title,created_at FROM notes WHERE instr(lower(title || body),lower(?))>0 ORDER BY created_at,id LIMIT ? OFFSET ?', args.query, args.limit, args.offset), total, nextOffset: args.offset + args.limit < total ? args.offset + args.limit : null };
      },
      readNote(input: unknown) { const { noteId } = z.strictObject({ noteId: z.string().uuid() }).parse(input); const note = store.get('SELECT * FROM notes WHERE id=?', noteId); if (!note) throw new Error('NOTE_NOT_FOUND'); return note; },
      async stop() { stopped = true; if (timer) clearInterval(timer); controller.abort(); await flight; },
      async close() { stopped = true; if (timer) clearInterval(timer); controller.abort(); await flight; await store.close(); }
    };
  } catch (error) { await store.close(); throw error; }
}
export type DailyService = Awaited<ReturnType<typeof openDailyService>>;
