import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";

// Darwin sys/fcntl.h: O_SHLOCK=0x10, O_EXLOCK=0x20. Node does not export these
// constants, but passes native open flags through. Desktop updates target macOS.
const O_SHLOCK = 0x10, O_EXLOCK = 0x20;
interface Held { filename: string; fd: number; closed: boolean; borrowers: number; exclusive: boolean }
const held = new WeakMap<SqliteAccessLease, Held>();
const activeDescriptors = new Set<number>();
export interface SqliteAccessLease { readonly fd: number; close(): void }
function filename(databasePath: string) {
    const directory = realpathSync(path.dirname(path.resolve(databasePath)));
    return path.join(directory, `.${path.basename(databasePath)}.access-lock`);
}
function releaseDescriptor(state: Held) { closeSync(state.fd); activeDescriptors.delete(state.fd); }
function makeLease(lock: string, fd: number, exclusive: boolean): SqliteAccessLease {
    const state: Held = { filename: lock, fd, closed: false, borrowers: 0, exclusive };
    const lease = Object.freeze({ fd, close() { if (!state.closed) { state.closed = true; if (state.borrowers === 0) releaseDescriptor(state); } } });
    held.set(lease, state); activeDescriptors.add(fd); return lease;
}

/** macOS cooperative access protocol. Each core connection holds a shared kernel
 * lock; an update may acquire exclusive access only after all such connections
 * close. Keep the lock inode permanently, including through DB replacement.
 * This does not certify exclusion of older clients or arbitrary SQLite libraries.
 */
export function acquireSqliteAccess(databasePath: string, exclusive = false): SqliteAccessLease | undefined {
    if (databasePath === ":memory:" || process.platform !== "darwin") return undefined;
    let fd: number | undefined;
    try {
        const lock = filename(databasePath);
        fd = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (exclusive ? O_EXLOCK : O_SHLOCK), 0o600);
        const info = fstatSync(fd);
        const current = lstatSync(lock);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size !== 0 ||
            current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw new Error();
        // Existing lock files may have broader permissions. Tighten the validated,
        // locked descriptor without replacing the inode used by other connections.
        if (info.mode & 0o077) fchmodSync(fd, 0o600);
        if (fstatSync(fd).mode & 0o077) throw new Error();
        return makeLease(lock, fd, exclusive);
    } catch {
        if (fd !== undefined) closeSync(fd);
        throw new Error("SQLITE_ACCESS_UNAVAILABLE");
    }
}

export function retainSqliteAccess(lease: SqliteAccessLease, databasePath: string): () => void {
    validateSqliteAccess(lease, databasePath);
    const state = held.get(lease)!; state.borrowers++;
    let released = false;
    return () => { if (!released) { released = true; state.borrowers--; if (state.closed && state.borrowers === 0) releaseDescriptor(state); } };
}

/** Host-only transfer descriptor. Source verifier connections must close before
 * transfer so SQLite handles themselves are not part of the handoff contract.
 */
export function exclusiveSqliteAccessDescriptor(lease: SqliteAccessLease, databasePath: string): number {
    validateSqliteAccess(lease, databasePath);
    const state = held.get(lease)!;
    if (!state.exclusive || state.borrowers !== 0) throw new Error("SQLITE_ACCESS_UNAVAILABLE");
    return state.fd;
}

/** Worker-only bootstrap after the native helper has verified/acquired LOCK_EX
 * on inherited fd 4..603. The private handoff supplies the corresponding paths.
 * No arbitrary IPC descriptor may invoke this; the JS layer verifies inode binding,
 * while the trusted native helper establishes lock mode before exec.
 */
export function adoptExclusiveSqliteAccess(databasePath: string, fd: number): SqliteAccessLease {
    try {
        if (process.platform !== "darwin" || !Number.isInteger(fd) || fd < 4 || fd > 603 || activeDescriptors.has(fd)) throw new Error();
        const lock = filename(databasePath), current = lstatSync(lock), owned = fstatSync(fd);
        if (!owned.isFile() || owned.nlink !== 1 || owned.uid !== process.getuid?.() || (owned.mode & 0o077) || owned.size !== 0 ||
            current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error();
        return makeLease(lock, fd, true);
    } catch { throw new Error("SQLITE_ACCESS_UNAVAILABLE"); }
}

/** Existing exclusive owner can open its own verifier/backup connections without
 * deadlocking on another shared lock. Only a live lease issued in this process
 * works; a structurally similar object or a replaced lock inode is rejected.
 */
export function validateSqliteAccess(lease: SqliteAccessLease, databasePath: string): void {
    try {
        const state = held.get(lease);
        if (!state || state.closed || state.filename !== filename(databasePath)) throw new Error();
        const current = lstatSync(state.filename), owned = fstatSync(state.fd);
        if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || current.dev !== owned.dev || current.ino !== owned.ino) throw new Error();
    } catch { throw new Error("SQLITE_ACCESS_UNAVAILABLE"); }
}
