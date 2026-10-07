import { mkdir, rm, rename, chmod, cp } from "node:fs/promises";
import { build as buildWeb } from "../../web/node_modules/vite/dist/node/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
// The embedded UI must use Code's engine protocol, even when the independently
// installed Web development package still carries an older registry engine.
await buildWeb({ configFile: path.join(root, "../web/vite.config.ts"), resolve: {
  alias: { "@zhivex-ai/harness/protocol": fileURLToPath(import.meta.resolve("@zhivex-ai/harness/protocol")) }
} });
await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(path.join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [path.join(root, "src/cli-entry.ts")],
  outdir: path.join(root, "dist"), target: "node", packages: "external", splitting: true,
});
if (!result.success) throw new AggregateError(result.logs, "Code build failed");
await rename(path.join(root, "dist/cli-entry.js"), path.join(root, "dist/cli.js"));
await chmod(path.join(root, "dist/cli.js"), 0o755);
await cp(path.join(root,"../web/dist"),path.join(root,"dist/web-assets"),{recursive:true});
