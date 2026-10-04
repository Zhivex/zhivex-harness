import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  lstat,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loopbackRequest, pairingToken } from "./local-smoke-http.mjs";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const root = await mkdtemp("/tmp/zcw-installed-");
const shortTemp = root + "/short-tmp";
await mkdir(shortTemp, { mode: 0o700 });
const canonicalRoot = await realpath(root);
const serviceName = `zhivex-code-web-${process.getuid?.() ?? "user"}`;
const socketSuffix = `/${serviceName}/${"0".repeat(20)}.sock`;
const longTemp = canonicalRoot + "/" + "t".repeat(102 - Buffer.byteLength(canonicalRoot + "/" + socketSuffix));
await mkdir(longTemp, { mode: 0o700 });
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
async function launch(binary, workspace, open = false, temporaryDirectory = shortTemp) {
  const binDir = root + "/bin";
  await mkdir(binDir, { recursive: true });
  const pairingFile = root + "/pairing";
  const opener = binDir + (process.platform === "darwin" ? "/open" : "/xdg-open");
  await writeFile(
    opener,
    `#!/usr/bin/env node\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pairingFile)},process.argv[2],{mode:0o600});\n`,
  );
  await chmod(opener, 0o755);
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
        TMPDIR: temporaryDirectory,
        OPENAI_API_KEY: "sk-offline-fixture-never-sent",
        NODE_NO_WARNINGS: "1",
        ZHIVEX_HARNESS_CONFIG_DIR: root + "/config",
        ZHIVEX_HARNESS_CREDENTIAL_STORE: "disabled",
        NODE_OPTIONS: `--import=${root}/deny-provider.mjs`,
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
    env: {
      PATH: binDir + ":" + process.env.PATH,
      TMPDIR: temporaryDirectory,
      OPENAI_API_KEY: "sk-offline-fixture-never-sent",
      NODE_NO_WARNINGS: "1",
      ZHIVEX_HARNESS_CONFIG_DIR: root + "/config",
    },
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
  await writeFile(root + "/deny-provider.mjs", `import {appendFileSync} from "node:fs"; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(root + "/provider-attempts")}, "attempt\\n"); throw new Error("INSTALLED_SMOKE_NETWORK_DENIED"); };`);
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
  const context = await connect.json();
  const workspaceKey = context.workspaces[0].key;
  async function configuredAction(action, args = {}) {
    const response = await fetch(first.origin + "/api/action", {
      method: "POST", redirect: "error", headers: {
        origin: first.origin, "content-type": "application/json", "x-zhivex-web": "1",
        "x-zhivex-csrf": context.csrf, cookie: connect.headers.get("set-cookie").split(";")[0],
      }, body: JSON.stringify({ workspaceKey, action, ...args }),
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  const catalog = await configuredAction("models");
  assert(catalog.choices.length > 0);
  assert(catalog.choices.every(c => c.capabilities.includes("chat") && c.capabilities.includes("tools")));
  assert(!JSON.stringify(catalog).includes("sk-offline-fixture-never-sent"));
  assert(catalog.choices.filter(c => c.configured).every(c => c.provider === "openai"));
  const alternative = catalog.choices.find(c => c.configured && c.model !== "gpt-6-luna");
  assert(alternative);
  const changed = await configuredAction("selectModel", { provider: alternative.provider, model: alternative.model });
  assert.equal(changed.workspace.key, workspaceKey);
  assert.equal(changed.workspace.model, alternative.model);
  const restored = await configuredAction("selectModel", { provider: "openai", model: "gpt-6-luna" });
  assert.equal(restored.workspace.model, "gpt-6-luna");
  assert.equal(await readFile(root + "/provider-attempts", "utf8").catch(() => ""), "");
  assert(!first.logs().includes(token));
  assert(!first.logs().includes("sk-offline-fixture-never-sent"));
  assert.equal(first.errors(), "");
  // A duplicate launch must fail without stealing/removing the active owner's state.
  const duplicate = spawnSync("node", [binary, "web", "--workspace", workspace,
    "--provider", "openai", "--model", "gpt-6-luna", "--no-open"], {
    env: first.env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /WEB_START_FAILED \(SERVICE_STATE_EXISTS\)/);
  assert(!duplicate.stderr.includes(root));
  assert.equal((await loopbackRequest(first.origin, "/")).status, 200);
  await first.stop();
  await assert.rejects(loopbackRequest(first.origin, "/"));
  const second = await launch(binary, workspace);
  await second.stop();
  assert.equal(Buffer.byteLength(path.join(await realpath(longTemp), serviceName,
    "0".repeat(20) + ".sock")), 102);
  const long = await launch(binary, workspace, false, longTemp);
  const fallback = await realpath(path.join("/tmp", serviceName));
  const fallbackInfo = await lstat(fallback);
  assert.equal(fallbackInfo.mode & 0o777, 0o700);
  assert.equal(fallbackInfo.uid, process.getuid?.());
  assert(Buffer.byteLength(path.join(fallback, "0".repeat(20) + ".sock")) <= 100);
  assert.equal((await loopbackRequest(long.origin, "/")).status, 200);
  await long.stop();
  const longRestart = await launch(binary, workspace, false, longTemp);
  await longRestart.stop();
  // Browser failure remains distinct from socket startup, then releases its own service.
  const opener = root + "/bin/" + (process.platform === "darwin" ? "open" : "xdg-open");
  await writeFile(opener, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  const browserFailure = spawnSync("node", [binary, "web", "--workspace", workspace,
    "--provider", "openai", "--model", "gpt-6-luna"], {
    env: first.env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(browserFailure.status, 1);
  assert.match(browserFailure.stdout, /Zhivex Code web listening/);
  assert.match(browserFailure.stderr, /WEB_BROWSER_OPEN_FAILED/);
  assert(!browserFailure.stderr.includes(root));
  const afterBrowserFailure = await launch(binary, workspace);
  await afterBrowserFailure.stop();
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
      "configured host model catalogue and selection preserve workspace identity",
      "unconfigured providers disabled and credentials absent from metadata",
      "provider fetch denied with zero attempts",
      "no credentials in assets or logs",
      "SIGTERM shutdown and fresh restart",
      "duplicate launcher preserves active service owner",
      "102-byte canonical preferred socket uses private short fallback",
      "long TMPDIR restart with existing workspace state",
      "browser opener failure is distinct and releases its own service",
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
