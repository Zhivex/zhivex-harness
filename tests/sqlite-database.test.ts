import { describe, expect, test } from "bun:test";

import { SqliteDatabase } from "../src/sqlite-database.js";

describe("SQLite runtime compatibility", () => {
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
