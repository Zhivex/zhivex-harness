import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loopbackRequest, pairingToken } from "./local-smoke-http.mjs";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const root = await mkdtemp("/tmp/zcw-installed-");
let child;
function run(command, args, cwd = root) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
async function launch(binary, workspace, open = false) {
  const binDir = root + "/bin";
  await mkdir(binDir, { recursive: true });
  const pairingFile = root + "/pairing";
  await writeFile(
    binDir + "/xdg-open",
    `#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pairingFile)},process.argv[2],{mode:0o600});\n`,
  );
  await chmod(binDir + "/xdg-open", 0o755);
  child = spawn(
    "node",
    [
      binary,
      "web",
      "--workspace",
      workspace,
      "--provider",
      "openai",
      "--model",
      "gpt-6-luna",
      ...(open ? [] : ["--no-open"]),
    ],
    {
      env: {
        PATH: binDir + ":" + process.env.PATH,
        OPENAI_API_KEY: "sk-offline-fixture-never-sent",
        NODE_NO_WARNINGS: "1",
        ZHIVEX_HARNESS_CONFIG_DIR: root + "/config",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  let logs = "",
    errors = "";
  child.stderr.on("data", (c) => (errors += c));
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("INSTALLED_START_TIMEOUT")),
      10000,
    );
    child.stdout.on("data", (c) => {
      logs += c;
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(errors));
    });
  });
  if (open) {
    for (let i = 0; i < 100; i++) {
      try {
        const link = await readFile(pairingFile, "utf8");
        pairingToken(link, origin);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }
  return {
    origin,
    logs: () => logs,
    errors: () => errors,
    async stop() {
      child.kill("SIGTERM");
      await stopped;
      assert.equal(child.exitCode, 0, errors);
    },
  };
}
try {
  const tar = process.env.CODE_WEB_ARTIFACT ? path.resolve(process.env.CODE_WEB_ARTIFACT) : root + "/code.tgz";
  if (!process.env.CODE_WEB_ARTIFACT) run(
    "bun",
    ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", tar],
    repo + "/packages/code",
  );
  const files = run("tar", ["-tzf", tar]).split("\n");
  assert(files.includes("package/dist/web-assets/index.html"));
  assert(files.some((f) => /web-assets\/assets\/.*\.js$/.test(f)));
  assert(!files.some((f) => /node_modules|\.map$|fixture|\.env/.test(f)));
  await mkdir(root + "/consumer");
  const candidateEngine = process.env.CODE_CANDIDATE_ENGINE;
  const codeManifest = JSON.parse(run("tar", ["-xOf", tar, "package/package.json"]));
  assert.deepEqual(codeManifest, JSON.parse(await readFile(repo + "/packages/code/package.json", "utf8")));
  const testedDigest = createHash("sha512").update(await readFile(tar)).digest("hex");
  if (candidateEngine) {
    const engine = JSON.parse(run("tar", ["-xOf", candidateEngine, "package/package.json"]));
    assert.equal(engine.name, "@zhivex-ai/harness");
    assert.equal(engine.version, codeManifest.dependencies["@zhivex-ai/harness"]);
  }
  await writeFile(root + "/consumer/package.json", JSON.stringify({ private: true,
    ...(candidateEngine ? { overrides: { "@zhivex-ai/harness": `file:${path.resolve(candidateEngine)}` } } : {}) }));
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tar],
    root + "/consumer",
  );
  const installedEngine = JSON.parse(await readFile(root + "/consumer/node_modules/@zhivex-ai/harness/package.json", "utf8"));
  assert.equal(installedEngine.version, codeManifest.dependencies["@zhivex-ai/harness"]);
  const binary = root + "/consumer/node_modules/@zhivex-ai/code/dist/cli.js";
  assert.match(
    run("node", [binary, "web", "--help"]),
    /Usage: zhivex-code web/,
  );
  const workspace = root + "/repo";
  await mkdir(workspace);
  const first = await launch(binary, workspace, true);
  const html = await loopbackRequest(first.origin, "/");
  assert.equal(html.status, 200);
  const page = await html.text();
  assert(page.includes("Zhivex Code"));
  const asset = page.match(/src="([^"]+\.js)"/)[1];
  const script = await (await loopbackRequest(first.origin, asset)).text();
  assert(!script.includes("sk-offline-fixture-never-sent"));
  assert(!/createProviderModel|OPENAI_API_KEY|Bearer/.test(script));
  const token = pairingToken(
    await readFile(root + "/pairing", "utf8"),
    first.origin,
  );
  const connect = await loopbackRequest(first.origin, "/api/connect", {
    method: "POST",
    headers: {
      origin: first.origin,
      "content-type": "application/json",
      "x-zhivex-web": "1",
    },
    body: JSON.stringify({ token }),
  });
  assert.equal(connect.status, 200);
  assert(connect.headers.get("set-cookie").includes("HttpOnly"));
  assert(!first.logs().includes(token));
  assert(!first.logs().includes("sk-offline-fixture-never-sent"));
  assert.equal(first.errors(), "");
  await first.stop();
  await assert.rejects(loopbackRequest(first.origin, "/"));
  const second = await launch(binary, workspace);
  await second.stop();
  assert.equal(createHash("sha512").update(await readFile(tar)).digest("hex"), testedDigest);
  const evidence = {
    passed: true,
    installation: candidateEngine ? "explicit exact candidate engine override" : "published registry engine",
    codeVersion: codeManifest.version,
    harnessVersion: codeManifest.dependencies["@zhivex-ai/harness"],
    sourceSha: run("git", ["rev-parse", "HEAD"], repo).trim(),
    packageSha512: testedDigest,
    packageSha256: createHash("sha256")
      .update(await readFile(tar))
      .digest("hex"),
    checks: [
      "tarball contains prebuilt assets",
      "npm install without build or Vite",
      "installed web command help",
      "browser opener invocation",
      "loopback launch and authenticated pairing",
      "no provider call",
      "no credentials in assets or logs",
      "SIGTERM shutdown and fresh restart",
    ],
  };
  const output = repo + "/packages/web/.test-output";
  await mkdir(output, { recursive: true });
  await writeFile(
    output + "/installed-report.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(root, { recursive: true, force: true });
}
