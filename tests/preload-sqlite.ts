import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

// Bun's macOS node:sqlite uses Apple SQLite, which cannot reopen a settled
// WAL database read-only without sidecars (oven-sh/bun#45171). Use standard
// SQLite for contributor tests; shipped Node/Electron runtimes are unaffected.
if (process.platform === "darwin") {
  const library = process.env.HARNESS_TEST_SQLITE_LIBRARY ?? [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib"
  ].find(existsSync);
  if (!library || !existsSync(library)) {
    throw new Error("Bun tests on macOS require standard SQLite: run `brew install sqlite` or set HARNESS_TEST_SQLITE_LIBRARY to its dylib path.");
  }
  // `bun test --parallel` isolates each file but reuses the worker process,
  // and the SQLite library is process-wide. This preload is the first code in
  // every file, so the first run in a worker sets the library; a later run
  // sees "already loaded" for that same library and has nothing to do.
  let configured: boolean;
  try {
    configured = Database.setCustomSQLite(library);
  } catch (error) {
    if (!/already loaded/i.test(String((error as Error)?.message ?? error))) throw error;
    configured = true;
  }
  if (!configured) {
    throw new Error("Cannot configure test SQLite: load tests/preload-sqlite.ts before opening any database.");
  }
}
