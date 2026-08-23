import { describe, test } from "bun:test";

import { verifyHistoricalMigrations } from "../scripts/verify-historical-migrations.js";

describe("published historical migration certification", () => {
  test("loads 0.10.0 and 0.11.1 fixtures under the current runtime", async () => {
    await verifyHistoricalMigrations();
  });
});
