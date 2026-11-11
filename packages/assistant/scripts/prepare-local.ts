import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "assistant-candidate-"));
function run(args: string[], cwd: string) {
  const result = spawnSync("bun", args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Local candidate setup failed");
}
try {
  const artifact = path.join(temporary, "harness.tgz");
  run(["pm", "pack", "--ignore-scripts", "--quiet", "--filename", artifact], path.resolve(root, "../.."));
  run(["install", "--no-save", "--ignore-scripts", artifact], root);
  console.log("Installed local Harness candidate without changing manifest or lockfile. A normal bun install restores the registry pin.");
} finally { await rm(temporary, { recursive: true, force: true }); }
