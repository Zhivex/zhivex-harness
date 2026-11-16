import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { acquireSqliteAccess, type SqliteAccessLease } from '../persistence/sqlite-access.js';
import { SqliteDatabase } from '../persistence/sqlite-database.js';
import { readRegularFileNoFollow } from '../workspace/file-security.js';
import { MIGRATION_MARKER } from '../persistence/migration-guard.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const relative = z.string().max(4096).refine(s => s.length > 0 && !path.isAbsolute(s) && s.split('/').every(p => p !== '' && p !== '.' && p !== '..'));
const manifestSchema = z.object({ version: z.literal(1), id: z.string().uuid(), roots: z.array(z.string()).min(1).max(32),
  files: z.array(z.object({ root: z.number().int().nonnegative(), name: relative, size: z.number().int().min(0).max(128 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(10000),
  directories: z.array(z.object({root: z.number().int().nonnegative(), name: relative}).strict()).max(10000),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;
const journalSchema = z.object({ version: z.literal(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(['copying', 'ready', 'restoring', 'restored', 'aborted']), expectedCurrentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), completed: z.array(relative).max(20000) }).strict();
function closeDatabase(db: SqliteDatabase) { try { db.exec('ROLLBACK'); } catch {} db.close(); }
const ignored = (name: string) => name === MIGRATION_MARKER || /^\.migration-write-[a-f0-9-]{36}$/.test(name) || /^\..+\.access-lock$/.test(name) ;
async function exists(filename: string) { try { await lstat(filename); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function directory(p: string) {
  const s = await lstat(p);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) || await realpath(p) !== p) throw new Error('MIGRATION_UNSAFE_DIRECTORY');
}
async function sync(p: string) { const h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW); try { await h.sync(); } finally { await h.close(); } }
async function bytes(p: string) {
  const f = await readRegularFileNoFollow(p, {label: 'migration', maxBytes: 128 * 1024 * 1024, requireSingleLink: true});
  if (f.stat.uid !== process.getuid?.() || f.stat.mode & 0o077) throw new Error('MIGRATION_UNSAFE_FILE');
  return f.contents;
}
async function write(p: string, value: Buffer | string) {
  await directory(path.dirname(p));
  const temporary = path.join(path.dirname(p), `.migration-write-${randomUUID()}`);
  const h = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(value); await h.sync(); } finally { await h.close(); }
  await rename(temporary, p); await sync(path.dirname(p));
}
async function scan(roots: string[]) {
  const files: Manifest['files'] = [], directories: Manifest['directories'] = []; let total = 0;
  async function visit(root: number, name: string) {
    const p = path.join(roots[root]!, name); await directory(p);
    for (const entry of (await readdir(p)).sort()) {
      if (ignored(entry)) continue;
      const child = path.join(p, entry), relativeName = name ? `${name}/${entry}` : entry;
      const stat = await lstat(child);
      if (stat.isSocket() && entry.endsWith('.sock')) continue;
      if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push({root, name: relativeName}); await visit(root, relativeName); }
      else {
        const data = await bytes(child); total += data.length;
        if (total > 512 * 1024 * 1024 || files.length >= 10000 || directories.length > 10000) throw new Error('MIGRATION_LIMIT');
        if (/(?:-wal|-journal)$/.test(entry) && data.length) throw new Error('MIGRATION_UNCHECKPOINTED_DATABASE');
        files.push({root, name: relativeName, size: data.length, sha256: hash(data)});
      }
    }
  }
  for (let i = 0; i < roots.length; i++) await visit(i, '');
  return {files, directories};
}
function nonoverlapping(paths: string[]) {
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const a = paths[i]!, b = paths[j]!;
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw new Error('MIGRATION_OVERLAPPING_ROOTS');
  }
}
/** Offline only: no schema inference, credential access, identity remapping or relocation.
 * Every caller-provided application/state root is copied byte-for-byte. Unknown files
 * are retained; sockets and cooperative lock inodes are operational, not user state.
 */
export async function applicationMigration(options: {
  roots: string[]; backup: string; action: 'backup' | 'inspect' | 'abort' | 'inspect-rollback' | 'rollback';
  expectedCurrentSha256?: string; afterWrite?: () => Promise<void>;
}) {
  if (process.platform !== 'darwin') throw new Error('MIGRATION_PLATFORM_UNSUPPORTED');
  const roots = options.roots.map(p => path.resolve(p)).sort(), backup = path.resolve(options.backup);
  if (!roots.length || roots.length > 32) throw new Error('MIGRATION_ROOTS_REQUIRED');
  nonoverlapping([...roots, backup]);
  for (const root of roots) await directory(root);
  await mkdir(backup, {recursive: true, mode: 0o700}); await directory(backup);
  const leases: SqliteAccessLease[] = [], databases: SqliteDatabase[] = [];
  const backupLease = acquireSqliteAccess(path.join(backup, 'migration'), true)!; leases.push(backupLease);
  let manifest: Manifest;
  const manifestPath = path.join(backup, 'manifest.json'), journalPath = path.join(backup, 'journal.json');
  try {
    for (const root of roots) leases.push(acquireSqliteAccess(path.join(root, 'migration'), true)!);
    if (await exists(manifestPath)) {
      manifest = manifestSchema.parse(JSON.parse((await bytes(manifestPath)).toString()));
      if (JSON.stringify(manifest.roots) !== JSON.stringify(roots) || manifest.files.some(f => f.root >= roots.length) || manifest.directories.some(f => f.root >= roots.length)) throw new Error('MIGRATION_ROOT_MISMATCH');
    } else {
      if (options.action !== 'backup') throw new Error('MIGRATION_BACKUP_REQUIRED');
      manifest = {version: 1, id: randomUUID(), roots, files: [], directories: []};
    }
    // Any old intent must belong to this exact backup; never clear somebody else's recovery.
    for (const root of roots) {
      const marker = path.join(root, MIGRATION_MARKER);
      if (await exists(marker) && (await bytes(marker)).toString() !== backup) throw new Error('MIGRATION_OTHER_RECOVERY_PENDING');
    }
    for (const root of roots) await write(path.join(root, MIGRATION_MARKER), backup);
    const current = await scan(roots);
    // Retain all cooperative locks before inspecting/copying the first database.
    const databaseFiles = new Map([...current.files, ...manifest.files].filter(f => /\.(sqlite|sqlite3|db)$/.test(f.name)).map(f => [`${f.root}/${f.name}`, f]));
    for (const file of databaseFiles.values()) {
      const filename = path.join(roots[file.root]!, file.name), access = acquireSqliteAccess(filename, true)!;
      leases.push(access);
      if (!await exists(filename)) continue;
      const db = new SqliteDatabase(filename, {create: false, accessLease: access}); databases.push(db);
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      if (path.basename(filename) === 'setup.sqlite') {
        const owner = db.query<{pid: number}>('SELECT pid FROM owner WHERE id=1').get();
        if (owner) {
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('MIGRATION_INVALID_OWNER');
          try { process.kill(owner.pid, 0); throw new Error('MIGRATION_WRITER_ACTIVE'); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        }
      }
    }
    const locked = await scan(roots);
    if (JSON.stringify(current) !== JSON.stringify(locked)) throw new Error('MIGRATION_SOURCE_CHANGED');
    if (!await exists(manifestPath)) { Object.assign(manifest, locked); await write(manifestPath, JSON.stringify(manifest)); }
    const manifestSha256 = hash(JSON.stringify(manifest));
    let journal = await exists(journalPath) ? journalSchema.parse(JSON.parse((await bytes(journalPath)).toString())) : {version: 1 as const, manifestSha256, phase: 'copying' as const, completed: [] as string[]};
    if (journal.manifestSha256 !== manifestSha256) throw new Error('MIGRATION_MANIFEST_CHANGED');
    const save = () => write(journalPath, JSON.stringify(journal));
    const currentSha256 = hash(JSON.stringify(locked));
    if (options.action === 'inspect') return {manifestSha256, currentSha256, phase: journal.phase, files: manifest.files.length};
    if (options.action === 'abort') {
      if (journal.phase === 'restoring' || options.expectedCurrentSha256 !== currentSha256) throw new Error('MIGRATION_ABORT_NOT_CONFIRMED');
      journal.phase = 'aborted'; await save();
      for (const root of roots) { await unlink(path.join(root, MIGRATION_MARKER)); await sync(root); }
      return {manifestSha256, currentSha256, phase: journal.phase, files: manifest.files.length};
    }
    if (options.action === 'backup') {
      if (JSON.stringify({files: manifest.files, directories: manifest.directories}) !== JSON.stringify(locked)) throw new Error('MIGRATION_SOURCE_CHANGED');
      if (!['copying','ready'].includes(journal.phase)) throw new Error('MIGRATION_RESTORE_PENDING');
      await save();
      const objects = path.join(backup, 'objects'); await mkdir(objects, {mode: 0o700, recursive: true}); await directory(objects);
      for (const file of manifest.files) {
        const target = path.join(objects, file.sha256);
        if (!await exists(target)) { const data = await bytes(path.join(roots[file.root]!, file.name)); if (hash(data) !== file.sha256) throw new Error('MIGRATION_SOURCE_CHANGED'); await write(target, data); await options.afterWrite?.(); }
        if (hash(await bytes(target)) !== file.sha256) throw new Error('MIGRATION_BACKUP_CORRUPT');
      }
      if (JSON.stringify(await scan(roots)) !== JSON.stringify(locked)) throw new Error('MIGRATION_SOURCE_CHANGED');
      journal.phase = 'ready'; await save();
    } else {
      if (!['ready', 'restoring', 'restored'].includes(journal.phase)) throw new Error('MIGRATION_BACKUP_INCOMPLETE');
      await directory(path.join(backup, 'objects'));
      for (const file of manifest.files) { const data = await bytes(path.join(backup, 'objects', file.sha256)); if (data.length !== file.size || hash(data) !== file.sha256) throw new Error('MIGRATION_BACKUP_CORRUPT'); }
      if (options.action === 'inspect-rollback') {
        if (journal.phase !== 'restoring') for (const root of roots) { await unlink(path.join(root, MIGRATION_MARKER)); await sync(root); }
        return {manifestSha256, currentSha256, phase: journal.phase, files: manifest.files.length};
      }
      if (!options.expectedCurrentSha256 || (journal.phase === 'ready' ? currentSha256 : journal.expectedCurrentSha256) !== options.expectedCurrentSha256) throw new Error('MIGRATION_ROLLBACK_CONFIRMATION_REQUIRED');
      if (journal.phase === 'restored' && JSON.stringify(locked.files) !== JSON.stringify(manifest.files)) throw new Error('MIGRATION_RESTORE_ALREADY_COMPLETED');
      if (journal.phase === 'ready') { await write(path.join(backup, 'before-rollback-manifest.json'), JSON.stringify(locked)); journal.phase = 'restoring'; journal.expectedCurrentSha256 = currentSha256; await save(); }
      // Release SQLite handles before replacing files; exclusive access leases and
      // durable startup barriers remain until the complete set is restored.
      for (const db of databases.splice(0)) closeDatabase(db);
      const quarantine = path.join(backup, 'before-rollback'); await mkdir(quarantine, {recursive: true, mode: 0o700}); await directory(quarantine);
      for (const dir of manifest.directories) { const p = path.join(roots[dir.root]!, dir.name); await mkdir(p, {recursive: true, mode: 0o700}); await directory(p); }
      const targets = new Map([...locked.files, ...manifest.files].map(f => [`${f.root}/${f.name}`, f]));
      for (const [key, file] of targets) {
        if (journal.completed.includes(key)) continue;
        const target = path.join(roots[file.root]!, file.name), saved = path.join(quarantine, hash(key));
        if (await exists(target) && !await exists(saved)) await write(saved, await bytes(target));
        const original = manifest.files.find(f => f.root === file.root && f.name === file.name);
        if (original) await write(target, await bytes(path.join(backup, 'objects', original.sha256)));
        else if (await exists(target)) { await unlink(target); await sync(path.dirname(target)); }
        journal.completed.push(key); await save(); await options.afterWrite?.();
      }
      // Verify every restored byte before clearing admission barriers. Post-backup
      // files survive in before-rollback; empty new directories are left intact.
      for (const file of manifest.files) if (hash(await bytes(path.join(roots[file.root]!, file.name))) !== file.sha256) throw new Error('MIGRATION_RESTORE_VERIFICATION_FAILED');
      journal.phase = 'restored'; await save();
    }
    for (const root of roots) { await unlink(path.join(root, MIGRATION_MARKER)); await sync(root); }
    return {manifestSha256, currentSha256, phase: journal.phase, files: manifest.files.length};
  } finally {
    for (const db of databases.reverse()) closeDatabase(db);
    for (const lease of leases.reverse()) lease.close();
  }
}
