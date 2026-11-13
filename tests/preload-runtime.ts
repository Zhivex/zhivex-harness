/** Test tooling only: production CLI/Tauri use Node's bundled SQLite. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

if (process.platform === "darwin") {
  // Apple's SQLite used by Bun cannot open a closed WAL store read-only when
  // sidecars are absent. Use a real SQLite library, never a writable fallback.
  const configured = process.env.BUN_SQLITE_LIBRARY;
  if (configured && !path.isAbsolute(configured)) throw new Error("BUN_SQLITE_LIBRARY must be an absolute trusted library path.");
  const library = configured ?? ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"].find(existsSync);
  if (!library || !Database.setCustomSQLite(library)) {
    throw new Error("Bun tests on macOS require Homebrew SQLite: brew install sqlite; or set BUN_SQLITE_LIBRARY to a trusted SQLite library. Production runs with Node.");
  }
}
