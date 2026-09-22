/** Native store integration using only a disposable test account, never CLI/Desktop accounts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";

if (!["darwin", "linux"].includes(process.platform)) throw new Error("Native credential smoke requires macOS or Linux.");
const entry = new AsyncEntry("ai.zhivex.harness.cli.test", randomUUID(), { linux: { store: "secret-service" } });
const timeout = () => AbortSignal.timeout(15_000);
try {
  assert.equal((await entry.getPassword(timeout())) ?? undefined, undefined);
  await entry.setPassword("synthetic-test-value-one", timeout());
  assert.equal(await entry.getPassword(timeout()), "synthetic-test-value-one");
  await entry.setPassword("synthetic-test-value-two", timeout());
  assert.equal(await entry.getPassword(timeout()), "synthetic-test-value-two");
  assert.equal(await entry.deleteCredential(timeout()), true);
  assert.equal((await entry.getPassword(timeout())) ?? undefined, undefined);
  console.log(`Native credential store passed on ${process.platform}: save, read, replace, delete.`);
} finally {
  // Separate namespace plus random account: no personal/production credentials are accessed.
  await entry.deleteCredential(timeout());
}
