import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/** Explicit offline consumer fixture only. Never changes published package pins. */
export async function sdkFixture(directory = process.env.ZHIVEX_SDK_FIXTURE) {
  if (!directory) return { overrides: {}, evidence: null };
  const root = path.resolve(directory);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.sourceDirty, false);
  assert.equal(manifest.repository, "Zhivex/zhivex-ai-sdk"); assert.match(manifest.commitSHA, /^[a-f0-9]{40}$/);
  assert.equal(manifest.packages.length, 3);
  const overrides = {}, packages = [];
  for (const item of manifest.packages) {
    assert(["@zhivex-ai/core", "@zhivex-ai/agents", "@zhivex-ai/sdk"].includes(item.name));
    assert(!overrides[item.name]); assert.equal(path.basename(item.file), item.file);
    const filename = path.join(root, item.file), bytes = await readFile(filename);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
    assert.equal(createHash("sha512").update(bytes).digest("hex"), item.sha512);
    overrides[item.name] = `file:${filename}`;
    packages.push({ name: item.name, version: item.version, sha256: item.sha256, sha512: item.sha512 });
  }
  return { overrides, evidence: { sourceSha: manifest.commitSHA, published: manifest.published, packages } };
}
