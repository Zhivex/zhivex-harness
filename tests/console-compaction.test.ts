import { expect, test } from "bun:test";
import { handleConsoleCompaction, type ConsoleCompactionDependencies } from "../src/cli/console/console-compaction.js";
import { bundledModelCatalog } from "../src/models/catalog.js";
import { parseCliArgs, type CliOptions } from "../src/cli/arguments.js";
import type { HarnessConfig } from "../src/runtime/config.js";
import { consoleCommands, formatConsoleHelp } from "../src/cli/console/console-commands.js";

function fixture(active = false) {
  const updates: CliOptions[] = [];
  const output: string[] = [];
  let reads = 0;
  const deps: ConsoleCompactionDependencies = {
    config: {compaction: {model: {provider: "openai", model: "gpt-6-luna"}}} as HarnessConfig,
    options: {...parseCliArgs(["chat"]), provider: "openai", model: "gpt-6-sol", compactionProvider: "openai", compactionModel: "gpt-6-luna"},
    hasActiveTurn: async () => active,
    replaceOptions: async value => { updates.push(value); },
    inspectCredential: async provider => ({configured: provider === "openai"}),
    loadCatalog: async () => { reads++; return {catalog: bundledModelCatalog, source: "bundled", stale: false}; },
    now: Date.parse("2026-09-25T00:00:00Z"),
    write: value => {output.push(value);},
  };
  return {deps, updates, output, reads: () => reads};
}

test("explicit compaction route rebuilds next-turn options and preserves primary model", async () => {
  const f = fixture();
  expect(await handleConsoleCompaction("/compaction gemini:custom/model:version", f.deps)).toBe(true);
  expect(f.updates).toHaveLength(1);
  expect(f.updates[0]).toMatchObject({provider: "openai", model: "gpt-6-sol", compactionProvider: "gemini", compactionModel: "custom/model:version"});
  expect(f.deps.options.compactionModel).toBe("gpt-6-luna");
  expect(f.reads()).toBe(0);
});

test("pending work blocks route changes and disabling without mutation", async () => {
  for (const command of ["/compaction off", "/compaction openai:gpt-6-sol"]) {
    const f = fixture(true);
    await handleConsoleCompaction(command, f.deps);
    expect(f.updates).toHaveLength(0);
    expect(f.output.join("")).toContain("pending work");
  }
});

test("off clears both explicit options for deterministic compaction", async () => {
  const f = fixture();
  await handleConsoleCompaction("/compaction off", f.deps);
  expect(f.updates[0]!.compactionModel).toBeUndefined();
  expect(f.updates[0]!.compactionProvider).toBeUndefined();
});

test("recommendation reads credential presence without auto-selecting or mutating pending work", async () => {
  const f = fixture(true);
  await handleConsoleCompaction("/compaction recommend", f.deps);
  expect(f.updates).toHaveLength(0);
  expect(f.reads()).toBe(1);
  const text = f.output.join("");
  expect(text).toContain("openai:gpt-6-luna");
  expect(text).not.toContain("gemini:gemini");
  expect(text).toContain("8,000 input");
  expect(text).toContain("No model selection changed");
  expect(text).toContain("route_unverified");
});

test("unknown metadata and missing credentials are explained", async () => {
  const f = fixture();
  f.deps.inspectCredential = async provider => ({configured: provider === "meta"});
  await handleConsoleCompaction("/compaction recommend", f.deps);
  expect(f.output.join("")).toContain("token_limits_unknown");
  f.deps.inspectCredential = async () => ({configured: false});
  await handleConsoleCompaction("/compaction recommend", f.deps);
  expect(f.output.join("")).toContain("No configured provider");
});

test("stale snapshot is disclosed and expired source evidence yields no recommendation", async () => {
  const f = fixture();
  const catalog = structuredClone(bundledModelCatalog);
  for (const provider of catalog.providers) for (const model of provider.models) {
    if (model.limits) model.limits.evidence.checkedAt = "2020-01-01";
  }
  f.deps.loadCatalog = async () => ({catalog, source: "cache", stale: true});
  await handleConsoleCompaction("/compaction recommend", f.deps);
  expect(f.output.join("")).toContain("cache; refresh unavailable or stale");
  expect(f.output.join("")).toContain("token_limits_stale");
  expect(f.output.join("")).not.toContain("Select explicitly:");
  expect(f.updates).toHaveLength(0);
});

test("invalid arguments never change route and status does not fetch", async () => {
  const f = fixture();
  for (const command of ["/compaction openai:", "/compaction fake:model", "/compaction openai:model with space", "/compaction openai:bad\u001b[31m"]) {
    await handleConsoleCompaction(command, f.deps);
  }
  await handleConsoleCompaction("/compaction", f.deps);
  expect(f.updates).toHaveLength(0);
  expect(f.reads()).toBe(0);
  expect(f.output.join("")).toContain("hybrid using openai:gpt-6-luna");
  expect(await handleConsoleCompaction("/compact", f.deps)).toBe(false);
});

test("failed rebuild does not mutate source options or report success", async () => {
  const f = fixture();
  f.deps.replaceOptions = async () => {throw new Error("no credentials");};
  await expect(handleConsoleCompaction("/compaction gemini:custom", f.deps)).rejects.toThrow("no credentials");
  expect(f.deps.options.compactionProvider).toBe("openai");
  expect(f.output).toHaveLength(0);
});

test("compaction command is discoverable only in direct console", () => {
  expect(formatConsoleHelp("direct", true)).toContain("/compaction");
  expect(consoleCommands("service").some(([name]) => name === "/compaction")).toBe(false);
});
