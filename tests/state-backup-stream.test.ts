import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalChunks, segmentedChunks, readBackupTransport } from "../src/persistence/state-backup-stream.js";

test("segmented transport preserves large strings, keys, Unicode and prototype-named properties", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-stream-"));
  try {
    const value = JSON.parse('{"__proto__":{"safe":true},"constructor":null}');
    value["k".repeat(100_000)] = ["x".repeat(8191) + "😀é\ud800", false, 2, {}, []];
    const file = path.join(root, "backup");
    await writeFile(file, [...segmentedChunks(value)].join(""), { mode: 0o600 });
    expect(await readBackupTransport(file, 10)).toEqual(value);
    expect(Object.prototype).not.toHaveProperty("safe");
    expect([...canonicalChunks(value)].join("")).toBe(JSON.stringify(value));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("segmented transport rejects truncation, extra roots, oversized frames and malformed structure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-stream-"));
  const magic = "ZHIVEX-STATE-SEGMENTS-1\n";
  try {
    for (const body of ['["object"]\n', '["end"]\n', '["value",1]\n["value",2]\n', '["text","unfinished"]\n', '["value",1]', '["object"]\n["text","key"]\n["string"]\n["end"]\n', JSON.stringify(["text", "x".repeat(70_000)]) + "\n"]) {
      const file = path.join(root, "backup");
      await writeFile(file, magic + body, { mode: 0o600 });
      await expect(readBackupTransport(file, 10)).rejects.toThrow();
    }
    const file = path.join(root, "legacy");
    await writeFile(file, JSON.stringify({ value: "x".repeat(100) }), { mode: 0o600 });
    await expect(readBackupTransport(file, 10)).rejects.toThrow("legacy size limit");
  } finally { await rm(root, { recursive: true, force: true }); }
});
