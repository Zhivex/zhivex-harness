import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveHarnessConfig } from "../src/config.js";
import {
  cleanupHarnessExecutionArtifacts,
  createHarnessOciExecutionEnvironment
} from "../src/execution-environment.js";
import { Workspace } from "../src/workspace.js";

const required = process.env.ZHIVEX_HARNESS_OCI_REQUIRED === "1";
const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-harness-oci-smoke-"));

try {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "zhivex-harness-oci-smoke",
    private: true,
    scripts: {
      test: "bun -e \"console.log('oci-check-ok')\""
    }
  }, null, 2));
  await writeFile(path.join(root, "src", "original.ts"), "export const original = true;\n");
  await writeFile(path.join(root, ".env"), "SMOKE_SECRET=must-not-be-mounted\n");
  await mkdir(path.join(root, "node_modules", "oci-smoke-dependency"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "oci-smoke-dependency", "package.json"), JSON.stringify({
    name: "oci-smoke-dependency",
    type: "module",
    exports: "./index.js"
  }));
  await writeFile(
    path.join(root, "node_modules", "oci-smoke-dependency", "index.js"),
    "export const value = 'read-only-dependency-ok';\n"
  );

  const config = resolveHarnessConfig({
    workspace: root,
    executionBackend: "oci",
    ociImage: process.env.ZHIVEX_HARNESS_OCI_IMAGE,
    ociAllowedCommands: ["bun"],
    ociMaxProcessRuntimeMs: 30_000,
    ociMaxMemoryMb: 256,
    ociMaxPids: 32,
    ociMaxCpus: 1,
    ociMaxWorkspaceBytes: 8 * 1024 * 1024,
    ociTmpfsMb: 64
  });
  if (config.execution.backend !== "oci") throw new Error("OCI smoke configuration was not enabled.");
  const workspace = await Workspace.open(root);
  let environment;
  try {
    environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory
    });
  } catch (error) {
    if (required) throw error;
    process.stdout.write(
      `OCI execution smoke skipped: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(0);
  }

  const session = await environment.acquire({ runId: "oci-smoke-run" });
  const command = await session.runCommand("bun", [
    "-e",
    [
      "import { access, writeFile } from 'node:fs/promises';",
      "let secretMounted = true;",
      "try { await access('/workspace/.env'); } catch { secretMounted = false; }",
      "if (secretMounted) throw new Error('secret file was mounted');",
      "let networkDenied = false;",
      "try { await fetch('https://example.com', { signal: AbortSignal.timeout(3000) }); } catch { networkDenied = true; }",
      "if (!networkDenied) throw new Error('network was not denied');",
      "let rootWriteDenied = false;",
      "try { await writeFile('/escape.txt', 'escape'); } catch { rootWriteDenied = true; }",
      "if (!rootWriteDenied) throw new Error('read-only root was writable');",
      "await writeFile('/workspace/src/generated.ts', 'export const isolated = true;\\n');",
      "console.log('oci-boundaries-ok');"
    ].join(" ")
  ]);
  assert.equal(command.exitCode, 0, command.stderr || command.stdout);
  assert.match(command.stdout, /oci-boundaries-ok/);

  const dependency = await session.runCommand("bun", [
    "-e",
    "import { value } from 'oci-smoke-dependency'; console.log(value)"
  ]);
  assert.equal(dependency.exitCode, 0, dependency.stderr || dependency.stdout);
  assert.match(dependency.stdout, /read-only-dependency-ok/);

  const check = await session.runCheck(
    "test",
    "bun -e \"console.log('oci-check-ok')\"",
    ["test"]
  );
  assert.equal(check.exitCode, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /oci-check-ok/);

  const inspection = await session.inspectPatch();
  assert.deepEqual(
    inspection.entries.map((entry) => [entry.path, entry.operation]),
    [["src/generated.ts", "create"]]
  );
  await assert.rejects(readFile(path.join(root, "src", "generated.ts"), "utf8"));
  const imported = await session.importPatch(workspace, inspection.patchId);
  assert.equal(imported.changes.length, 1);
  assert.equal(
    await readFile(path.join(root, "src", "generated.ts"), "utf8"),
    "export const isolated = true;\n"
  );
  assert.equal(await readFile(path.join(root, ".env"), "utf8"), "SMOKE_SECRET=must-not-be-mounted\n");

  const controller = new AbortController();
  const cancelled = session.runCommand("bun", ["-e", "await Bun.sleep(60_000)"] , {
    abortSignal: controller.signal
  } as never);
  setTimeout(() => controller.abort(), 250);
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.exitCode, 130);
  assert.match(cancelledResult.stderr, /cancelled/i);

  const outputLimited = await session.runCommand("bun", [
    "-e",
    "process.stdout.write('a'.repeat(15000)); process.stderr.write('b'.repeat(15000)); await Bun.sleep(60000)"
  ]);
  assert.equal(outputLimited.exitCode, 125);
  assert.match(outputLimited.stderr, /output limit/i);

  const workspaceLimited = await session.runCommand("bun", [
    "-e",
    "import { writeFile } from 'node:fs/promises'; await writeFile('/workspace/fill.bin', new Uint8Array(16 * 1024 * 1024).fill(1))"
  ]);
  assert.notEqual(workspaceLimited.exitCode, 0);
  assert.match(`${workspaceLimited.stderr}\n${workspaceLimited.stdout}`, /space|ENOSPC/i);
  await assert.rejects(session.workspace.readFile("fill.bin"));

  await assert.rejects(
    session.runCommand("bun", [
      "-e",
      "import { writeFile } from 'node:fs/promises'; await writeFile('/workspace/oversized.bin', new Uint8Array(2 * 1024 * 1024).fill(1))"
    ]),
    /file above the .*byte limit/i
  );
  await assert.rejects(session.workspace.readFile("oversized.bin"));

  const memoryLimited = await session.runCommand("bun", [
    "-e",
    "const held=[]; for (;;) held.push(new Uint8Array(16 * 1024 * 1024).fill(1))"
  ]);
  assert.notEqual(memoryLimited.exitCode, 0);

  const pidsLimited = await session.runCommand("bun", [
    "-e",
    [
      "import { readFile, readdir } from 'node:fs/promises';",
      "const configured=Number((await readFile('/sys/fs/cgroup/pids.max','utf8')).trim());",
      "if (configured !== 32) throw new Error(`unexpected PID ceiling: ${configured}`);",
      "const children=[];",
      "try {",
      "try { for (let index=0; index<96; index+=1) {",
      "const child=Bun.spawn(['bun','-e','await Bun.sleep(60000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});",
      "children.push(child);",
      "} } catch {}",
      "await Bun.sleep(250);",
      "const active=(await readdir('/proc')).filter((name)=>/^\\d+$/.test(name)).length;",
      "if (active > configured) throw new Error(`PID ceiling exceeded: ${active}`);",
      "} finally { for (const child of children) child.kill(); }",
      "console.log('pids-limit-ok');"
    ].join(" ")
  ]);
  assert.equal(pidsLimited.exitCode, 0, pidsLimited.stderr || pidsLimited.stdout);
  assert.match(pidsLimited.stdout, /pids-limit-ok/);

  await session.release?.({ status: "completed" });
  await environment.runtime.cleanupOrphans();
  const cleanup = await cleanupHarnessExecutionArtifacts(config.stateDirectory, Date.now() + 1_000);
  assert.equal(cleanup.deleted, 1);
  process.stdout.write(
    `OCI execution smoke passed for ${environment.image.runtime} ${environment.image.runtimeVersion}, image ${environment.image.imageDigest}.\n`
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
