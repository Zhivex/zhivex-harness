import { mkdir, rm, rename, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(path.join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [path.join(root, "src/cli-entry.ts")],
  outdir: path.join(root, "dist"), target: "node", packages: "external", splitting: true,
});
if (!result.success) throw new AggregateError(result.logs, "Code build failed");
await rename(path.join(root, "dist/cli-entry.js"), path.join(root, "dist/cli.js"));
await chmod(path.join(root, "dist/cli.js"), 0o755);
