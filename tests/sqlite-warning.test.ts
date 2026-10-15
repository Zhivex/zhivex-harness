import { expect, test } from "bun:test";
import { installSqliteExperimentalWarningFilter } from "../src/persistence/sqlite-database.js";

test("the sqlite experimental warning is dropped and other warnings remain", async () => {
  installSqliteExperimentalWarningFilter();
  const seen: string[] = [];
  const onWarning = (warning: Error) => { seen.push(`${warning.name}:${warning.message}`); };
  process.on("warning", onWarning);
  try {
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("keep this diagnostic", "ExperimentalWarning");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(seen.some(line => line.includes("SQLite is an experimental feature"))).toBe(false);
    expect(seen).toContain("ExperimentalWarning:keep this diagnostic");
  } finally {
    process.off("warning", onWarning);
  }
});
