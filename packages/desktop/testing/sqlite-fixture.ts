import {createRequire} from "node:module";
import type {DatabaseSync, SQLInputValue} from "node:sqlite";
import {acquireSqliteAccess, exclusiveSqliteAccessDescriptor, type SqliteAccessLease} from "@zhivex-ai/harness/desktop/v1/state";

/** Test-only raw SQL access for constructing/corrupting disposable recovery fixtures.
 * This is not the engine SQL implementation: secret rejection and statement
 * binding tests remain in Harness. A borrowed exclusive lease must outlive the
 * fixture, and the fixture must close before the owner transfers that lease.
 */
export class SqliteFixture {
  private database: DatabaseSync;
  private ownedLease: SqliteAccessLease | undefined;
  constructor(filename: string, options: {readonly?: boolean; accessLease?: SqliteAccessLease} = {}) {
    if (options.accessLease) exclusiveSqliteAccessDescriptor(options.accessLease, filename);
    else this.ownedLease = acquireSqliteAccess(filename);
    try {
      const {DatabaseSync} = createRequire(process.execPath)("node:sqlite") as typeof import("node:sqlite");
      this.database = new DatabaseSync(filename, {readOnly: options.readonly ?? false});
    } catch (error) {this.ownedLease?.close(); throw error;}
  }
  exec(sql: string) {this.database.exec(sql);}
  query<T extends object = Record<string, unknown>>(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      run: (...values: SQLInputValue[]) => statement.run(...values),
      get: (...values: SQLInputValue[]) => statement.get(...values) as T | undefined,
      all: (...values: SQLInputValue[]) => statement.all(...values) as T[]
    };
  }
  close(throwOnError = true) {
    try {this.database.close();} catch (error) {if (throwOnError) throw error;}
    finally {this.ownedLease?.close();}
  }
}
