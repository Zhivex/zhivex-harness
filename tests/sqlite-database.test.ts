import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteDatabase } from "../packages/core/src/persistence/sqlite-database.js";

describe("SQLite runtime compatibility", () => {
  for (const liveWriter of [false, true]) {
    test(`reads ${liveWriter ? "uncheckpointed" : "settled sidecarless"} WAL without permitting writes`, () => {
      const directory = mkdtempSync(path.join(tmpdir(), "harness-readonly-wal-"));
      const filename = path.join(directory, "state.sqlite");
      let writer: SqliteDatabase | undefined = new SqliteDatabase(filename);
      let reader: SqliteDatabase | undefined;
      try {
        writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('saved');");
        if (!liveWriter) {
          writer.close();
          writer = undefined;
          expect(existsSync(`${filename}-wal`)).toBe(false);
          expect(existsSync(`${filename}-shm`)).toBe(false);
        } else {
          expect(readFileSync(`${filename}-wal`).length).toBeGreaterThan(0);
        }
        const before = readFileSync(filename);
        reader = new SqliteDatabase(filename, { readonly: true });
        expect(reader.query("SELECT value FROM items").all()).toEqual([{ value: "saved" }]);
        expect(() => reader!.exec("INSERT INTO items VALUES ('forbidden')")).toThrow(/readonly|read-only/i);
        reader.close();
        reader = undefined;
        expect(readFileSync(filename)).toEqual(before);
      } finally {
        reader?.close();
        writer?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("binds numbered parameters portably and preserves repeated indices", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      const row = database.query<{
        first: string;
        repeated: string;
        second: string;
      }, [string, string]>(`
        SELECT ?1 AS first, ?1 AS repeated, ?2 AS second
      `).get("alpha", "beta");

      expect(row).toEqual({
        first: "alpha",
        repeated: "alpha",
        second: "beta"
      });
      expect(() => database.query("SELECT ?2").get("missing"))
        .toThrow("require exactly 2 bindings; received 1");
    } finally {
      database.close();
    }
  });

  test("retains anonymous and caller-supplied named bindings", () => {
    const database = new SqliteDatabase(":memory:");
    try {
      expect(database.query<{ value: string }, [string]>("SELECT ? AS value").get("anonymous"))
        .toEqual({ value: "anonymous" });
      expect(database.query<{ value: string }, [{ $value: string }]>("SELECT $value AS value")
        .get({ $value: "named" }))
        .toEqual({ value: "named" });
    } finally {
      database.close();
    }
  });
});
