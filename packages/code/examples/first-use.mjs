#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Open the tutorial in an interactive terminal.");
const root = fileURLToPath(new URL("../", import.meta.url));
const selector = process.argv.indexOf("--workspace");
const workspace = selector < 0 ? await mkdtemp(path.join(os.tmpdir(), "zhivex-code-tutorial-")) : path.resolve(process.argv[selector + 1]);
await mkdir(workspace, { recursive: true });
// Never replace an existing user's fixture or state.
for (const [name, contents] of Object.entries({
  "greeting.mjs": 'export const greeting = (name) => `Hi, ${name}`;\n',
  "greeting.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "./greeting.mjs";\ntest("greets by name", () => assert.equal(greeting("Miguel"), "Hello, Miguel!"));\n',
  "package.json": JSON.stringify({ private: true, type: "module", scripts: { test: "node --test greeting.test.mjs" } }, null, 2) + "\n",
  "prices.json": JSON.stringify({ schemaVersion: 1, prices: [{ provider: "openai", model: "gpt-5.6-luna",
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: "Synthetic offline tutorial rates; not provider prices",
    asOf: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() }] }, null, 2) + "\n",
})) {
  try { await access(path.join(workspace, name)); }
  catch { await writeFile(path.join(workspace, name), contents, { flag: "wx" }); }
}
process.stdout.write(`Offline Code tutorial · ${workspace}
All model responses and token counts are synthetic. No provider calls or payments.
1. Ask: Inspect fixture
2. /checkpoint capture ["greeting.mjs"]
3. /budget 1 → prices.json → type budget (USD estimate per new RUN)
4. Ask: Fix greeting → review the file diff → choose Allow once
5. Ask: Check greeting → review the command → choose Allow once
6. /usage → inspect the estimate and the check receipt in /activity
7. Ask: Interrupt fixture → wait for the instruction → Ctrl+C
8. /exit, then reopen with the command below; /continue retains the results in a NEW run
9. /checkpoint restore → review → type prepare → review the exact proposal → type restore
   The selected text file is restored and the captured conversation is forked.
Reopen: node ${JSON.stringify(path.join(root, "examples/first-use.mjs"))} --workspace ${JSON.stringify(workspace)}
\n`);
const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const child = spawn(process.execPath, ["--import", path.join(root, "examples/offline-provider.mjs"), path.join(root, "dist/cli.js"),
  "chat", "--provider", "openai", "--model", "gpt-5.6-luna", "--workspace", workspace,
  "--state-dir", path.join(workspace, ".zhivex-harness"), "--continue", "--allow-check", "test"], {
  stdio: "inherit", cwd: workspace, env: { ...env, HOME: workspace, NODE_NO_WARNINGS: "1",
    OPENAI_API_KEY: "offline-fixture-only", CODE_TUTORIAL_WORKSPACE: workspace,
    ZHIVEX_HARNESS_CREDENTIAL_STORE: "disabled", ZHIVEX_HARNESS_CONFIG_DIR: path.join(workspace, ".tutorial-config") },
});
// SIGINT is handled by the console to preserve durable progress.
const interrupt = () => {}; process.on("SIGINT", interrupt);
child.on("exit", (code, signal) => { process.off("SIGINT", interrupt); process.exitCode = code ?? (signal ? 1 : 0); });
