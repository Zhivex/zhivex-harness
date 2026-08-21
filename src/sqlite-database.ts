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

const normalizeNumberedParameters = (sql: string) => {
  const indexes = new Set<number>();
  const normalizedSql = sql.replace(/\?([1-9]\d*)/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex);
    indexes.add(index);
    return `$__zhivex_${index}`;
  });
  return {
    sql: normalizedSql,
    indexes: [...indexes].sort((left, right) => left - right)
  };
};

const numberedBindings = (indexes: readonly number[], parameters: readonly unknown[]) => {
  if (indexes.length === 0) return undefined;
  const maximumIndex = indexes.at(-1)!;
  if (parameters.length !== maximumIndex) {
    throw new Error(
      `SQLite numbered parameters require exactly ${maximumIndex} binding${maximumIndex === 1 ? "" : "s"}; received ${parameters.length}.`
    );
  }
  return Object.fromEntries(indexes.map((index) => [`$__zhivex_${index}`, parameters[index - 1]]));
};

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
    // Node 22.13 exposes SQLite's numbered `?NNN` syntax but its JavaScript
    // positional binder rejects it with SQLITE_RANGE. Normalizing only those
    // placeholders to prefixed named bindings preserves repeated indices and
    // keeps anonymous `?` plus caller-supplied named parameters unchanged.
    const normalized = normalizeNumberedParameters(sql);
    const statement = this.#database.prepare(normalized.sql);
    const invoke = <T>(method: (...parameters: never[]) => T, parameters: readonly unknown[]) => {
      const bindings = numberedBindings(normalized.indexes, parameters);
      return bindings
        ? method(bindings as never)
        : method(...parameters as unknown as never[]);
    };
    return {
      run: (...parameters) => invoke(statement.run.bind(statement), parameters),
      get: (...parameters) => invoke(statement.get.bind(statement), parameters) as TResult | undefined,
      all: (...parameters) => invoke(statement.all.bind(statement), parameters) as TResult[]
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
