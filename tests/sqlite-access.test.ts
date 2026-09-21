import {expect, test} from "bun:test";
import {mkdir, mkdtemp, realpath, rm, unlink, symlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {SqliteDatabase} from "../src/sqlite-database.js";
import {acquireSqliteAccess, exclusiveSqliteAccessDescriptor, adoptExclusiveSqliteAccess, type SqliteAccessLease} from "../src/sqlite-access.js";
const nativeTest = process.platform === "darwin" ? test : test.skip;
async function fixture(run: (file: string) => Promise<void>) {const root = await realpath(await mkdtemp("/tmp/har-sqlite-access-")); try {await run(path.join(root, "operations.sqlite"));} finally {await rm(root, {recursive: true, force: true});}}
nativeTest("all live core connections block exclusivity; exclusive owner blocks new connections", () => fixture(async file => {
 const first = new SqliteDatabase(file), second = new SqliteDatabase(file);
 try {first.exec("CREATE TABLE value(n INTEGER)"); expect(() => acquireSqliteAccess(file, true)).toThrow("SQLITE_ACCESS_UNAVAILABLE");} finally {first.close();}
 expect(() => acquireSqliteAccess(file, true)).toThrow("SQLITE_ACCESS_UNAVAILABLE"); second.close();
 const exclusive = acquireSqliteAccess(file, true)!;
 try {
  expect(() => new SqliteDatabase(file)).toThrow("SQLITE_ACCESS_UNAVAILABLE");
  const own = new SqliteDatabase(file, {accessLease: exclusive}); try {own.exec("INSERT INTO value VALUES(7)");} finally {own.close();}
  expect(() => new SqliteDatabase(file)).toThrow("SQLITE_ACCESS_UNAVAILABLE");
 } finally {exclusive.close();}
 const reopened = new SqliteDatabase(file); try {expect(reopened.query<{n: number}>("SELECT n FROM value").get()!.n).toBe(7);} finally {reopened.close();}
}));
nativeTest("borrowed connections keep the lock until SQLite closes even if their owner releases early", () => fixture(async file => {
 const lease = acquireSqliteAccess(file, true)!, db = new SqliteDatabase(file, {accessLease: lease});
 const statement = db.query("SELECT 1"); lease.close();
 try {expect(() => statement.get()).toThrow("SQLITE_ACCESS_UNAVAILABLE"); expect(() => acquireSqliteAccess(file, true)).toThrow("SQLITE_ACCESS_UNAVAILABLE");} finally {db.close();}
 const next = acquireSqliteAccess(file, true)!; next.close();
}));
nativeTest("forged, wrong-database and closed leases cannot bypass exclusion", () => fixture(async file => {
 const lease = acquireSqliteAccess(file, true)!;
 try {
  expect(() => new SqliteDatabase(file, {accessLease: {fd: lease.fd, close() {}} as SqliteAccessLease})).toThrow("SQLITE_ACCESS_UNAVAILABLE");
  expect(() => new SqliteDatabase(path.join(path.dirname(file), "other.sqlite"), {accessLease: lease})).toThrow("SQLITE_ACCESS_UNAVAILABLE");
 } finally {lease.close();}
 expect(() => new SqliteDatabase(file, {accessLease: lease})).toThrow("SQLITE_ACCESS_UNAVAILABLE");
}));
nativeTest("replaced lock inode invalidates statements prepared before the replacement", () => fixture(async file => {
 const db = new SqliteDatabase(file); const statement = db.query("SELECT 1");
 try {
  const lock = path.join(path.dirname(file), ".operations.sqlite.access-lock"); await unlink(lock); await writeFile(lock, "", {mode: 0o600});
  expect(() => statement.get()).toThrow("SQLITE_ACCESS_UNAVAILABLE"); expect(() => db.exec("CREATE TABLE unexpected(n)")).toThrow("SQLITE_ACCESS_UNAVAILABLE");
 } finally {db.close();}
}));
nativeTest("symlink lock and failed SQLite construction leave no usable or leaked lease", () => fixture(async file => {
 const lock = path.join(path.dirname(file), ".operations.sqlite.access-lock"), target = path.join(path.dirname(file), "target"); await writeFile(target, ""); await symlink(target, lock);
 expect(() => new SqliteDatabase(file)).toThrow("SQLITE_ACCESS_UNAVAILABLE"); await unlink(lock);
 await mkdir(file); expect(() => new SqliteDatabase(file)).toThrow();
 const lease = acquireSqliteAccess(file, true)!; lease.close();
}));
nativeTest("transfer requires exclusive access with no borrowed connections; adoption cannot duplicate a live lease", () => fixture(async file => {
 const shared = acquireSqliteAccess(file)!;
 try {expect(() => exclusiveSqliteAccessDescriptor(shared, file)).toThrow("SQLITE_ACCESS_UNAVAILABLE");} finally {shared.close();}
 const exclusive = acquireSqliteAccess(file, true)!;
 try {
  const db = new SqliteDatabase(file, {accessLease: exclusive});
  try {expect(() => exclusiveSqliteAccessDescriptor(exclusive, file)).toThrow("SQLITE_ACCESS_UNAVAILABLE");} finally {db.close();}
  expect(exclusiveSqliteAccessDescriptor(exclusive, file)).toBe(exclusive.fd);
  expect(() => adoptExclusiveSqliteAccess(file, exclusive.fd)).toThrow("SQLITE_ACCESS_UNAVAILABLE");
  expect(() => adoptExclusiveSqliteAccess(file, 3)).toThrow("SQLITE_ACCESS_UNAVAILABLE");
 } finally {exclusive.close();}
}));
