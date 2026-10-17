import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio, palette } from "../src/palette.js";
import {
  clampDiffWidth,
  defaultDiffLayout,
  DIFF_HANDLE_PX,
  DIFF_MIN_WIDTH,
  effectiveDiffPosition,
  EMPTY_DIFF_WIDTH,
  nextDiffPosition,
  nudgeDiffSize,
  readDiffLayout,
  SIDE_MIN_VIEWPORT,
  CHAT_MIN_WIDTH,
} from "../src/diff-layout.js";
import { formatContext, formatCost, showsImages, toWebModelChoice } from "../src/model-choice.js";
import { modelRows, providerCredentialNote, readModelPickerMemory, rememberModel, toggleFavorite } from "../src/model-picker-state.js";
import { altShiftAction } from "../src/shortcuts.js";
import { runStatusLabel } from "../src/status-label.js";
import {
  addRegisteredProject,
  planRegistrySync,
  PROJECT_LIMIT,
  readProjectRegistry,
  removeRegisteredProject,
  writeProjectRegistry,
} from "../src/project-registry.js";
import { runProjectCli } from "../src/project-cli.js";
import { parseWebArgs, reconcileRegistryProjects } from "../src/cli.js";
import { startWebServer } from "../src/server.js";
import type { WebRuntime } from "../src/runtime.js";
import type { WebModelChoice } from "../src/contracts.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("direction B text pairs meet AA in both themes", () => {
  for (const theme of [palette.light, palette.dark]) {
    expect(contrastRatio(theme.text, theme.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.text, theme.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.secondary, theme.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.secondary, theme.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.accent === "#c30500" ? "#ffffff" : "#140000", theme.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.diffAddText, theme.diffAddBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.diffDelText, theme.diffDelBg)).toBeGreaterThanOrEqual(4.5);
  }
  expect(palette.light.accent).toBe("#c30500");
  expect(palette.dark.accent).not.toBe("#fa0100");
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  expect(css).toContain(".approve, .app-shell .primary { background: var(--ink)");
  expect(css).not.toContain("#fa0100");
});

test("diff layout clamps, skips side below 1024 and nudges from the keyboard", () => {
  expect(clampDiffWidth(100, 1440)).toBe(DIFF_MIN_WIDTH);
  expect(clampDiffWidth(5000, 1440)).toBe(1440 - CHAT_MIN_WIDTH - DIFF_HANDLE_PX);
  expect(effectiveDiffPosition("side", SIDE_MIN_VIEWPORT - 1)).toBe("bottom");
  expect(effectiveDiffPosition("side", SIDE_MIN_VIEWPORT)).toBe("side");
  expect(nextDiffPosition("side", 900)).toBe("full");
  expect(nextDiffPosition("bottom", 1440)).toBe("full");
  expect(nudgeDiffSize(500, "ArrowRight", false, 420, 900)).toBe(516);
  expect(nudgeDiffSize(500, "ArrowLeft", true, 420, 900)).toBe(436);
  expect(nudgeDiffSize(500, "Home", false, 420, 900)).toBe(420);
  expect(nudgeDiffSize(500, "End", false, 420, 900)).toBe(900);
  expect(nudgeDiffSize(500, "Enter", false, 420, 900)).toBe(500);
  expect(EMPTY_DIFF_WIDTH).toBe(340);
  const saved = readDiffLayout(JSON.stringify({ position: "side", widthPx: 10, heightPx: 10, minimized: true }));
  expect(saved.widthPx).toBe(DIFF_MIN_WIDTH);
  expect(saved.minimized).toBe(true);
  expect(readDiffLayout("not-json")).toEqual(defaultDiffLayout());
});

test("model choices copy only published context and USD cost", () => {
  const published = toWebModelChoice({
    provider: "openai", providerName: "OpenAI", id: "gpt-test", name: "GPT Test",
    configured: true, capabilities: ["chat", "tools", "vision"], validation: "verified",
    limits: { contextWindowTokens: 128000, contextWindowType: "combined" },
    pricing: { currency: "USD", inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 },
  });
  expect(published.contextWindow).toEqual({ tokens: 128000, type: "combined" });
  expect(published.cost).toEqual({ currency: "USD", inputPerMillionTokens: 1.25, outputPerMillionTokens: 10 });
  expect(showsImages(published)).toBe(true);
  expect(formatContext(published)).toBe("128,000 tokens");
  expect(formatCost(published)).toContain("$1.25 in");
  const unpublished = toWebModelChoice({
    provider: "gemini", providerName: "Gemini", id: "fixture-missing", name: "Fixture missing",
    configured: false, capabilities: ["chat", "tools"], validation: "unverified",
    pricing: { currency: "EUR", inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  });
  expect(unpublished.contextWindow).toBeUndefined();
  expect(unpublished.cost).toBeUndefined();
  expect(showsImages(unpublished)).toBe(false);
  expect(formatCost(unpublished)).toBe("");
});

test("model rows group favorites and recents and keep unconfigured providers visible", () => {
  const choices: WebModelChoice[] = [
    { provider: "openai", providerName: "OpenAI", model: "current", name: "Fixture current", configured: true, capabilities: ["chat"], validation: "verified" },
    { provider: "anthropic", providerName: "Anthropic", model: "fixture-next", name: "Fixture next", configured: true, capabilities: ["chat"], validation: "unverified" },
    { provider: "gemini", providerName: "Gemini", model: "fixture-missing", name: "Fixture missing", configured: false, capabilities: ["chat"], validation: "unverified" },
  ];
  const memory = rememberModel(toggleFavorite(readModelPickerMemory(null), "openai/current"), "anthropic/fixture-next");
  const rows = modelRows(choices, memory, "");
  expect(rows.filter(row => row.group === "Favorites").map(row => row.choice.name)).toEqual(["Fixture current"]);
  expect(rows.filter(row => row.group === "Recent").map(row => row.choice.name)).toEqual(["Fixture next"]);
  expect(rows.some(row => row.choice.name === "Fixture missing" && row.disabled)).toBe(true);
  expect(providerCredentialNote(choices, "Gemini")).toBe(true);
  expect(providerCredentialNote(choices, "OpenAI")).toBe(false);
  expect(modelRows(choices, memory, "zzzz")).toEqual([]);
  expect(modelRows(choices, memory, "missing").map(row => row.choice.model)).toEqual(["fixture-missing"]);
});

test("shortcuts are Alt+Shift codes and ignore bare or command chords", () => {
  const event = (code: string, extra: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
    altShiftAction({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code, ...extra });
  expect(event("KeyA")).toBe("approve");
  expect(event("KeyR")).toBe("reject");
  expect(event("KeyP")).toBe("position");
  expect(event("KeyH")).toBe("minimize");
  expect(event("KeyM")).toBe("model");
  expect(event("KeyS")).toBe("favorite");
  expect(event("KeyJ")).toBe("drawer");
  expect(event("KeyN")).toBe("session");
  expect(event("KeyK")).toBeUndefined();
  expect(event("KeyA", { altKey: false })).toBeUndefined();
  expect(event("KeyA", { ctrlKey: true })).toBeUndefined();
  expect(event("KeyA", { metaKey: true })).toBeUndefined();
  expect(event("Enter")).toBeUndefined();
});

test("status labels stay human and hide raw enums", () => {
  expect(runStatusLabel("waiting_approval")).toBe("Needs you");
  expect(runStatusLabel("completed")).toBe("Done");
  expect(runStatusLabel("failed")).toBe("Error");
  expect(runStatusLabel("running")).toBe("Running");
  expect(runStatusLabel("cancelled")).toBe("Cancelled");
  expect(runStatusLabel("waiting_approval")).not.toContain("_");
});

test("shared tool policy is rejected when more than one workspace is explicit", () => {
  expect(() => parseWebArgs(["--workspace", "a", "--workspace", "b", "--tool-policy", "/tmp/policy.json"])).toThrow("WEB_USAGE_INVALID");
  expect(parseWebArgs(["--workspace", "only", "--tool-policy", "/tmp/policy.json"]).values["--tool-policy"]).toBe("/tmp/policy.json");
});

test("project registry confirms the real path, stays private and plans live sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhivex-registry-"));
  directories.push(root);
  const folder = path.join(root, "atlas");
  const missing = path.join(root, "gone");
  const file = path.join(root, "projects.json");
  await mkdir(folder);
  await expect(addRegisteredProject(folder, { file, confirm: () => false })).rejects.toThrow("PROJECT_CONFIRMATION_MISMATCH");
  await expect(readProjectRegistry(file)).resolves.toEqual([]);
  const added = await addRegisteredProject(folder, { file, confirm: answer => answer === folder });
  expect(added.map(project => project.path)).toEqual([folder]);
  const info = await lstat(file);
  expect(info.mode & 0o077).toBe(0);
  await chmod(file, 0o644);
  await expect(readProjectRegistry(file)).rejects.toThrow("PROJECT_REGISTRY_UNSAFE");
  await chmod(file, 0o600);
  const link = path.join(root, "linked.json");
  await symlink(file, link);
  await expect(readProjectRegistry(link)).rejects.toThrow("PROJECT_REGISTRY_UNSAFE");
  const removed = await removeRegisteredProject(folder, { file, confirm: answer => answer === folder });
  expect(removed).toEqual([]);
  expect(await lstat(folder).then(item => item.isDirectory())).toBe(true);
  await writeProjectRegistry([{ path: folder, name: "atlas", addedAt: 1 }, { path: missing, name: "gone", addedAt: 2 }], file);
  const plan = planRegistrySync([{ path: folder, source: "flag" }], [
    { path: folder, name: "atlas", addedAt: 1 },
    { path: missing, name: "gone", addedAt: 2 },
  ]);
  expect(plan.detach).toEqual([]);
  expect(plan.start.map(project => project.path)).toEqual([missing]);
  const capped = planRegistrySync(
    Array.from({ length: PROJECT_LIMIT }, (_, index) => ({ path: `/p/${index}`, source: "flag" as const })),
    [{ path: missing, name: "gone", addedAt: 2 }],
  );
  expect(capped.start).toEqual([]);
  expect(capped.unavailable[0]?.cause).toContain(String(PROJECT_LIMIT));
});

test("project add confirms the typed path and does not ask the browser for a folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhivex-project-cli-"));
  directories.push(root);
  const folder = path.join(root, "shop");
  const file = path.join(root, "projects.json");
  await mkdir(folder);
  await expect(runProjectCli(["add"], {
    cwd: folder,
    file,
    prompt: async () => "not-the-path",
  })).rejects.toThrow("PROJECT_CONFIRMATION_MISMATCH");
  await writeFile(path.join(root, "policy.json"), "{}\n", { mode: 0o600 });
  await runProjectCli(["add", "--tool-policy", path.join(root, "policy.json")], {
    cwd: folder,
    file,
    prompt: async () => folder,
  });
  const projects = await readProjectRegistry(file);
  expect(projects[0]?.path).toBe(folder);
  expect(projects[0]?.toolPolicy).toBe(path.join(root, "policy.json"));
  await runProjectCli(["add"], { cwd: folder, file, prompt: async () => folder });
  expect((await readProjectRegistry(file))[0]?.toolPolicy).toBe(path.join(root, "policy.json"));
  await writeFile(path.join(root, "other-policy.json"), "{}\n", { mode: 0o600 });
  await runProjectCli(["add", "--tool-policy", path.join(root, "other-policy.json")], {
    cwd: folder,
    file,
    prompt: async () => folder,
  });
  expect((await readProjectRegistry(file))[0]?.toolPolicy).toBe(path.join(root, "other-policy.json"));
});

test("a registry policy change is reopened and the web runtime lists the new policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhivex-policy-runtime-"));
  directories.push(root);
  const folder = path.join(root, "atlas");
  const assets = path.join(root, "assets");
  const file = path.join(root, "projects.json");
  const policy = path.join(root, "restricted.json");
  await mkdir(folder);
  await mkdir(assets);
  await writeFile(path.join(assets, "index.html"), "<!doctype html><title>fixture</title>\n");
  await writeFile(policy, "{}\n", { mode: 0o600 });
  await runProjectCli(["add"], { cwd: folder, file, prompt: async () => folder });
  await runProjectCli(["add", "--tool-policy", policy], { cwd: folder, file, prompt: async () => folder });
  const registered = await readProjectRegistry(file);
  expect(registered[0]?.toolPolicy).toBe(policy);
  const previous = stubRuntime("atlas-key", folder, undefined);
  const host = await startWebServer({ runtimes: [previous], assetsDirectory: assets });
  try {
    const opened: string[] = [];
    await reconcileRegistryProjects({
      registered,
      active: [{ path: folder, source: "registry" }],
      keyFor: candidate => candidate === folder ? previous.workspace.key : undefined,
      detach: async () => { await previous.close(); },
      drop() {},
      async open(project) {
        opened.push(project.toolPolicy ?? "");
        return stubRuntime("atlas-key", folder, project.toolPolicy ? path.basename(project.toolPolicy) : undefined);
      },
      attach: runtime => host.directory.attach(runtime),
      markUnavailable: project => host.directory.markUnavailable(project),
      clearUnavailable: key => host.directory.clearUnavailable(key),
      unavailableKey: () => undefined,
      rememberUnavailable: (workspace, cause) => ({ key: "unavailable", name: "atlas", workspace, provider: "", model: "", unavailable: true, cause }),
    });
    expect(opened).toEqual([policy]);
    const origin = host.origin;
    const headers = { origin, "content-type": "application/json", "x-zhivex-web": "1" };
    const token = new URL(host.launchUrl).hash.slice("#connect=".length);
    const pair = await fetch(origin + "/api/connect", { method: "POST", headers, body: JSON.stringify({ token }) });
    const doc = await pair.json() as { csrf: string; workspaces: { toolPolicy?: string }[] };
    expect(doc.workspaces[0]?.toolPolicy).toBe("restricted.json");
    const cookie = pair.headers.get("set-cookie")!.split(";")[0]!;
    const context = await fetch(origin + "/api/context", {
      method: "POST",
      headers: { ...headers, cookie, "x-zhivex-csrf": doc.csrf },
      body: "{}",
    });
    const again = await context.json() as { workspaces: { toolPolicy?: string }[] };
    expect(again.workspaces.map(item => item.toolPolicy)).toEqual(["restricted.json"]);
    expect(planRegistrySync([{ path: folder, source: "flag" }], registered).refresh).toEqual([]);
    const removed = planRegistrySync([{ path: folder, source: "registry", toolPolicy: policy }], registered.map(project => ({ path: project.path, name: project.name, addedAt: project.addedAt })));
    expect(removed.refresh.map(project => project.toolPolicy)).toEqual([undefined]);
  } finally {
    await host.close();
  }
});

function stubRuntime(key: string, folder: string, toolPolicy: string | undefined): WebRuntime {
  return {
    workspace: {
      key,
      name: "atlas",
      workspace: folder,
      provider: "openai",
      model: "fixture",
      ...(toolPolicy ? { toolPolicy } : {}),
    },
    forgetIdentity() {},
    async close() {},
  } as unknown as WebRuntime;
}
