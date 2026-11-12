import { syncPrivateDirectory } from '../private-directory.js';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function openTelegramStore(directory: string, recover = false) {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) || directoryStat.uid !== process.getuid?.()) throw new Error('TELEGRAM_STATE_UNSAFE');
  const lockPath = path.join(directory, 'telegram.lock');
  const readPrivate = async (filename: string) => {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const s = await file.stat(); if (!s.isFile() || (s.mode & 0o077) || s.uid !== process.getuid?.() || s.size > 4096) throw new Error('TELEGRAM_STATE_UNSAFE');
      return await file.readFile('utf8'); } finally { await file.close(); }
  };
  if (recover) {
    const guardPath = path.join(directory, 'telegram.recovery');
    const guard = await open(guardPath, 'wx', 0o600);
    await guard.close();
    try {
      try {
      const owner = JSON.parse(await readPrivate(lockPath));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('TELEGRAM_LOCK_INVALID');
      try { process.kill(owner.pid, 0); throw new Error('TELEGRAM_OWNER_ALIVE'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await unlink(lockPath);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } finally { await unlink(guardPath); }
  }
  const lock = await open(lockPath, 'wx', 0o600);
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync(); } finally { await lock.close(); }
  let db: DatabaseSync | undefined;
  try {
    const filename = path.join(directory, 'telegram.sqlite');
    try { const file = await open(filename, 'wx', 0o600); await file.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { const s = await lstat(filename + suffix); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.uid !== process.getuid?.()) throw new Error('TELEGRAM_DB_UNSAFE'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    db = new DatabaseSync(filename);
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', intent TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, message_id INTEGER);
      CREATE TABLE IF NOT EXISTS reviews(token TEXT PRIMARY KEY, snapshot TEXT NOT NULL, delivery_id TEXT NOT NULL,
        expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`);
    if (!(db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).some(column => column.name === 'expires_at')) {
      db.exec('ALTER TABLE outbox ADD COLUMN expires_at INTEGER');
    }
    const database = db;
    const get = <T>(sql: string, ...args: (string | number | null)[]) => database.prepare(sql).get(...args) as T | undefined;
    const all = <T>(sql: string, ...args: (string | number | null)[]) => database.prepare(sql).all(...args) as T[];
    const run = (sql: string, ...args: (string | number | null)[]) => database.prepare(sql).run(...args);
    const transaction = <T>(fn: () => T) => { database.exec('BEGIN IMMEDIATE'); try { const result = fn(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; } };
    const meta = (key: string) => get<{ value: string }>('SELECT value FROM meta WHERE key=?', key)?.value;
    const set = (key: string, value: string) => run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
    if (meta('schemaVersion') && meta('schemaVersion') !== '1') throw new Error('TELEGRAM_SCHEMA_UNSUPPORTED');
    set('schemaVersion', '1');
    run("UPDATE outbox SET status='uncertain' WHERE status='sending'");
    await syncPrivateDirectory(directory, 'TELEGRAM_STATE_UNSAFE', directoryStat);
    let closed = false;
    return { get, all, run, transaction, meta, set,
      async close() { if (closed) return; closed = true; database.close(); await unlink(lockPath); } };
  } catch (error) { db?.close(); await unlink(lockPath); throw error; }
}
export type TelegramStore = Awaited<ReturnType<typeof openTelegramStore>>;
