import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_JSON_SCHEMA_VERSION, HARNESS_VERSION } from "@zhivex-ai/harness/engine";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const binary = path.join(packageRoot, "dist/cli.js");
const run = (args: string[], cwd = packageRoot) => spawnSync("node", [binary, ...args], {
  encoding: "utf8", cwd, timeout: 15_000,
  env: { PATH: process.env.PATH, HOME: cwd, NO_COLOR: "1", NODE_NO_WARNINGS: "1" },
});

describe("standalone Node terminal product", () => {
  test("owns a distinct executable and advertises its own identity", async () => {
    expect(manifest.bin).toEqual({ "zhivex-code": "./dist/cli.js" });
    expect(manifest.engines.node).toBe(">=22.13.0");
    expect(manifest.scripts).not.toHaveProperty("postinstall");
    expect((await readFile(binary, "utf8")).startsWith("#!/usr/bin/env node")).toBe(true);
    for (const args of [["--version"], ["version"], ["-v"]]) {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(manifest.version);
      expect(result.stderr).toBe("");
    }
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Zhivex Code");
    expect(help.stdout).toContain("zhivex-code init");
    expect(help.stdout).not.toContain("supported aliases");
  });

  test("provider JSON and usage errors retain schema and exit contracts", () => {
    const providers = run(["providers", "--json"]);
    expect(providers.status).toBe(0);
    const document = JSON.parse(providers.stdout);
    expect(document).toMatchObject({schemaVersion: CLI_JSON_SCHEMA_VERSION, kind: "providers"});
    expect(document.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({id: "anthropic", credentialNames: ["ANTHROPIC_API_KEY"]}),
      expect.objectContaining({id: "vertex", credentialNames: [], configured: false}),
    ]));
    expect(run(["providers"]).stdout).toContain("missing GOOGLE_CLOUD_PROJECT/VERTEX_LOCATION");
    for (const args of [["run", "--json", "--bogus"], ["run", "--json", "--jsonl", "task"]]) {
      const result = run(args);
      expect(result.status).toBe(2);
      const document = JSON.parse(result.stdout || result.stderr);
      expect(document).toMatchObject({schemaVersion: CLI_JSON_SCHEMA_VERSION, error: {code: "CLI_USAGE_INVALID", category: "usage", retryable: false}});
    }
  });

  test("explicit noninteractive onboarding creates a compatible profile without a secret", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "zhivex-code-first-use-"));
    try {
      const result = run(["init", "--json"], cwd);
      expect(result.status).toBe(0);
      const document = JSON.parse(result.stdout);
      expect(document).toMatchObject({ schemaVersion: 1, kind: "init", credential: {configured: false}, profile: {name: "default", schemaVersion: 1} });
      expect(document.next.doctor).toBe("zhivex-code doctor --profile default");
      const profile = await readFile(document.profile.path, "utf8");
      expect(JSON.parse(profile)).toMatchObject({schemaVersion: 1});
      expect(profile).not.toMatch(/apiKey|password|secret/);
    } finally { await rm(cwd, {recursive: true, force: true}); }
  });

  test("doctor identifies the engine dependency independently from Code", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "zhivex-code-doctor-"));
    try {
      const result = run(["doctor", "--json", "--workspace", cwd, "--state-dir", path.join(cwd,"state")], cwd);
      expect([0, 3]).toContain(result.status!);
      expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, kind: "doctor", harnessVersion: HARNESS_VERSION });
    } finally { await rm(cwd, {recursive: true, force: true}); }
  });
});

test("built Code imports only declared dependencies and public Harness subpaths", async () => {
  const { readdir } = await import("node:fs/promises");
  const dependencies = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.optionalDependencies)]);
  const allowedHarness = new Set(["@zhivex-ai/harness/engine", "@zhivex-ai/harness/client", "@zhivex-ai/harness/code-support", "@zhivex-ai/harness/protocol", "@zhivex-ai/harness/service", "@zhivex-ai/harness/desktop/v1/state"]);
  const transpiler = new Bun.Transpiler({loader: "js"});
  let harnessImports = 0;
  for (const file of await readdir(path.join(packageRoot, "dist"))) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(path.join(packageRoot, "dist", file), "utf8");
    for (const edge of transpiler.scanImports(source.replace(/^#!.*$/gm, ""))) {
      const specifier = edge.path;
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) {
        expect(path.dirname(path.resolve(packageRoot, "dist", specifier))).toBe(path.join(packageRoot, "dist"));
        continue;
      }
      const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
      expect(dependencies.has(packageName)).toBe(true);
      if (packageName === "@zhivex-ai/harness") {
        harnessImports++;
        expect(allowedHarness.has(specifier)).toBe(true);
      }
    }
  }
  expect(harnessImports).toBeGreaterThan(0);
});
