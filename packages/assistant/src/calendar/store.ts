import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { open, lstat, mkdir, unlink } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';

/** Separate host-private journal; credentials are encrypted with an externally supplied key. */
export async function openCalendarStore(directory: string, encodedKey: string, recover = false) {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) throw new Error('CALENDAR_KEY_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) || root.uid !== process.getuid?.()) throw new Error('CALENDAR_STATE_UNSAFE');
  const lockPath = path.join(directory, 'calendar.lock');
  if (recover) {
    const guardPath = path.join(directory, 'calendar.recovery'); const guard = await open(guardPath, 'wx', 0o600); await guard.close();
    try {
      try {
        const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let pid: number;
        try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('CALENDAR_LOCK_UNSAFE');
          pid = JSON.parse(await handle.readFile('utf8')).pid; } finally { await handle.close(); }
        if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error('CALENDAR_LOCK_INVALID');
        try { process.kill(pid!, 0); throw new Error('CALENDAR_OWNER_ALIVE'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        await unlink(lockPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } finally { await unlink(guardPath); }
  }
  const lock = await open(lockPath, 'wx', 0o600);
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); } finally { await lock.close(); }
  let db: DatabaseSync | undefined;
  try {
    const file = path.join(directory, 'calendar.sqlite');
    try { const created = await open(file, 'wx', 0o600); await created.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { const stat = await lstat(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('CALENDAR_DB_UNSAFE'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, proposal TEXT NOT NULL, status TEXT NOT NULL, result TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS single_active_event ON operations(json_extract(proposal,'$.connectionId'),json_extract(proposal,'$.eventId')) WHERE status IN ('dispatching','uncertain');`);
    const database = db;
    const get = <T>(sql: string, ...args: (string | number | null)[]) => database.prepare(sql).get(...args) as T | undefined;
    const run = (sql: string, ...args: (string | number | null)[]) => database.prepare(sql).run(...args);
    const meta = (name: string) => get<{ value: string }>('SELECT value FROM meta WHERE key=?', name)?.value;
    const set = (name: string, value: string) => run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', name, value);
    if (meta('schema') && meta('schema') !== '1') throw new Error('CALENDAR_SCHEMA_UNSUPPORTED'); set('schema', '1');
    run("UPDATE operations SET status='uncertain' WHERE status='dispatching'");
    const encrypt = (name: string, value: unknown) => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(`assistant-calendar-v1:${name}`));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      set(name, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    };
    const decrypt = <T>(name: string): T | undefined => {
      const stored = meta(name); if (!stored) return;
      try { const value = JSON.parse(stored), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
        decipher.setAAD(Buffer.from(`assistant-calendar-v1:${name}`)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')) as T;
      } catch { throw new Error('CALENDAR_CREDENTIAL_DECRYPT_FAILED'); }
    };
    if (meta('keyCheck')) { if (decrypt<string>('keyCheck') !== 'calendar') throw new Error('CALENDAR_KEY_INVALID'); } else encrypt('keyCheck', 'calendar');
    const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    let closed = false;
    return { get, run, meta, set, encrypt, decrypt, async close() { if (!closed) { closed = true; database.close(); key.fill(0); await unlink(lockPath); } } };
  } catch (error) { db?.close(); key.fill(0); await unlink(lockPath); throw error; }
}
export type CalendarStore = Awaited<ReturnType<typeof openCalendarStore>>;
