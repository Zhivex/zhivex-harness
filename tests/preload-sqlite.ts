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
  // `bun test --parallel` isolates each file's globals but reuses the worker
  // process, so this preload runs again after the process-wide SQLite library
  // is already set. The marker lives in the process environment (shared across
  // isolated files) and is bound to this pid, so child processes that inherit
  // it still configure their own library.
  const marker = `${process.pid}:${library}`;
  if (process.env.HARNESS_TEST_SQLITE_CONFIGURED !== marker) {
    if (!Database.setCustomSQLite(library)) {
      throw new Error("Cannot configure test SQLite: load tests/preload-sqlite.ts before opening any database.");
    }
    process.env.HARNESS_TEST_SQLITE_CONFIGURED = marker;
  }
}
