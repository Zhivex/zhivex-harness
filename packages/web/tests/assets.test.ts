import { afterEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readRegularFileNoFollow } from "@zhivex-ai/harness/desktop/v1/state";
import { staticInventory } from "../src/server.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function assets() {
  const root = await mkdtemp("/tmp/zcw-asset-race-");
  roots.push(root);
  await mkdir(root + "/public");
  await writeFile(root + "/public/index.html", "original");
  return { root, directory: root + "/public" };
}

test("asset snapshots retain validated bytes after startup", async () => {
  const f = await assets();
  const inventory = await staticInventory(f.directory);
  await writeFile(f.directory + "/index.html", "changed after snapshot");
  expect(inventory.get("/index.html")?.bytes.toString()).toBe("original");
});

test("asset inventory rejects inode replacement between inspection and read", async () => {
  const f = await assets();
  await expect(
    staticInventory(f.directory, async (filename, options) => {
      await rename(filename, f.root + "/retained");
      await writeFile(filename, "replacement");
      return readRegularFileNoFollow(filename, options);
    }),
  ).rejects.toThrow("WEB_ASSETS_UNSAFE");
});

test("asset inventory rejects symlink ancestors introduced before descriptor open", async () => {
  const f = await assets();
  await mkdir(f.directory + "/assets");
  await writeFile(f.directory + "/assets/app.js", "trusted");
  await mkdir(f.root + "/outside");
  await writeFile(f.root + "/outside/app.js", "outside secret");
  let replaced = false;
  await expect(
    staticInventory(f.directory, async (filename, options) => {
      if (path.basename(filename) === "app.js") {
        replaced = true;
        await rename(f.directory + "/assets", f.root + "/retained");
        await symlink(f.root + "/outside", f.directory + "/assets");
      }
      return readRegularFileNoFollow(filename, options);
    }),
  ).rejects.toThrow("WEB_ASSETS_UNSAFE");
  expect(replaced).toBe(true);
});

test("asset inventory bounds growth after inspection and rejects mutation after EOF", async () => {
  const growing = await assets();
  await expect(
    staticInventory(growing.directory, async (filename, options) => {
      await appendFile(filename, Buffer.alloc(4 * 1024 * 1024));
      return readRegularFileNoFollow(filename, options);
    }),
  ).rejects.toThrow("WEB_ASSETS_UNSAFE");
  const changing = await assets();
  await expect(
    staticInventory(changing.directory, async (filename, options) => {
      const stable = await readRegularFileNoFollow(filename, options);
      await appendFile(filename, "late mutation");
      return stable;
    }),
  ).rejects.toThrow("WEB_ASSETS_UNSAFE");
});

test("a FIFO substituted after inspection cannot block asset startup", async () => {
  const f = await assets();
  await expect(
    staticInventory(f.directory, async (filename, options) => {
      await rename(filename, f.root + "/retained");
      expect(Bun.spawnSync(["mkfifo", filename]).exitCode).toBe(0);
      return readRegularFileNoFollow(filename, options);
    }),
  ).rejects.toThrow("WEB_ASSETS_UNSAFE");
}, 1500);
