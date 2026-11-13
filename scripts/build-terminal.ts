import { readdir, rename, copyFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const terminalModules = (await readdir(path.join(root, "src/cli"), { recursive: true }))
  .filter(file => file.endsWith(".ts")).map(file => `src/cli/${file}`);
// One build graph is essential: terminal helpers and engine hosts must share
// runtime identity (approval authority, task budgets and persistence leases).
const entries = ["index", "service-cli", "acp-cli", "audit/index", "engine/index",
  "engine/protocol", "engine/client", "engine/service", "engine/acp", "engine/models",
  "engine/desktop-state-v1", "engine/desktop-providers-v1", "compat/code-support",
  "engine/mcp-stdio-v1", "terminal", "cli-entry"].map(file => `src/${file}.ts`);
const result = await Bun.build({
  entrypoints: [...entries, ...terminalModules].map(file => path.join(root, file)),
  root: path.join(root, "src"), outdir: path.join(root, "dist"),
  target: "node", packages: "external", splitting: true,
});
if (!result.success) throw new AggregateError(result.logs, "Harness and terminal build failed");
await rename(path.join(root, "dist/cli-entry.js"), path.join(root, "dist/cli.js"));
await copyFile(path.join(root, "dist/cli.js"), path.join(root, "dist/zhx.js"));
