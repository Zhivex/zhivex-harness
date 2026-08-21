import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
let DatabaseSyncConstructor: typeof import("node:sqlite")["DatabaseSync"] | undefined;

const loadDatabaseSync = () => {
  DatabaseSyncConstructor ??= (
    require("node:sqlite") as typeof import("node:sqlite")
  ).DatabaseSync;
  return DatabaseSyncConstructor;
};

export interface SqliteDatabaseOptions {
  create?: boolean;
  readonly?: boolean;
  strict?: boolean;
}

export interface SqliteStatement<
  TResult extends object = Record<string, unknown>,
  TParameters extends readonly unknown[] = readonly unknown[]
> {
  run(...parameters: TParameters): unknown;
  get(...parameters: TParameters): TResult | undefined;
  all(...parameters: TParameters): TResult[];
}

/**
 * Small compatibility surface over Node's built-in SQLite implementation.
 *
 * Keeping the Bun-style `query()` shape local avoids coupling the persistence
 * code to either runtime while the database itself remains standard SQLite.
 */
export class SqliteDatabase {
  readonly #database: NodeDatabaseSync;

  constructor(databasePath: string, options: SqliteDatabaseOptions = {}) {
    // Callers create and validate writable database files before opening them.
    // `create` and `strict` are retained in the local options shape so existing
    // call sites keep documenting that contract; node:sqlite is strict about
    // missing bindings by default.
    void options.create;
    void options.strict;
    const DatabaseSync = loadDatabaseSync();
    this.#database = new DatabaseSync(databasePath, {
      ...(options.readonly === undefined ? {} : { readOnly: options.readonly })
    });
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  query<
    TResult extends object = Record<string, unknown>,
    TParameters extends readonly unknown[] = readonly unknown[]
  >(sql: string): SqliteStatement<TResult, TParameters> {
    const statement = this.#database.prepare(sql);
    return {
      run: (...parameters) => statement.run(...parameters as unknown as never[]),
      get: (...parameters) => statement.get(...parameters as unknown as never[]) as TResult | undefined,
      all: (...parameters) => statement.all(...parameters as unknown as never[]) as TResult[]
    };
  }

  close(throwOnError = true): void {
    try {
      this.#database.close();
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
    }
  }
}
