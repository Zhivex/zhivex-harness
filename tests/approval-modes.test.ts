import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentApprovalRequest } from "@zhivex-ai/agents";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { parseCliArgs } from "../src/cli/arguments.js";
import { terminalApprovalResolver } from "../src/cli/presentation.js";
import { readDependency } from "../src/tools/dependency-read.js";
import { terminalRunFailure } from "../src/cli/terminal/terminal-ui.js";

const approval = (name = "read_dependency", pkg = "@scope/sdk", id = "a"): AgentApprovalRequest =>
  ({ id, provider: "meta", name, arguments: JSON.stringify({ package: pkg, file: "package.json", startLine: 1 }) } as AgentApprovalRequest);

test("approval modes parse explicitly and cannot conflict with --yes", () => {
  for (const mode of ["ask", "auto", "restricted"] as const) {
    const parsed = parseCliArgs(["run", "--approval-mode", mode, "task"]);
    expect(parsed.approvalMode).toBe(mode);
    expect(parsed.yes).toBe(mode === "auto");
  }
  expect(() => parseCliArgs(["chat", "--approval-mode", "unsafe"])).toThrow();
  expect(() => parseCliArgs(["chat", "--yes", "--approval-mode", "ask"])).toThrow();
  expect(() => parseCliArgs(["chat", "--service", "host.json", "--approval-mode", "auto"])).toThrow();
});

test("restricted denies without prompting; auto still asks for dependency access", async () => {
  const restricted = terminalApprovalResolver("restricted", async () => { throw new Error("must not prompt"); });
  expect((await restricted([approval()], {} as never))?.[0]?.approve).toBe(false);
  let prompts = 0;
  const auto = terminalApprovalResolver("auto", async () => { prompts++; return "n"; });
  expect((await auto([approval("apply_patch")], {} as never))?.[0]?.approve).toBe(true);
  expect((await auto([approval()], {} as never))?.[0]?.approve).toBe(false);
  expect(prompts).toBe(1);
});

test("dependency grants are package and task scoped; once and abandoned batches do not grant", async () => {
  let prompts = 0;
  const task = terminalApprovalResolver("ask", async () => { prompts++; return "t"; });
  await task([approval()], {} as never);
  await task([approval("read_dependency", "@scope/sdk", "b")], {} as never);
  expect(prompts).toBe(1);
  await task([approval("read_dependency", "other", "c")], {} as never);
  expect(prompts).toBe(2);
  const once = terminalApprovalResolver("ask", async () => { prompts++; return "y"; });
  await once([approval()], {} as never); await once([approval()], {} as never);
  expect(prompts).toBe(4);
  const answers = ["t", "q", "n"];
  const abandoned = terminalApprovalResolver("ask", async () => answers.shift()!);
  expect(await abandoned([approval(), approval("apply_patch")], {} as never)).toBeUndefined();
  expect((await abandoned([approval()], {} as never))?.[0]?.approve).toBe(false);
});

test("dependency reads are bounded metadata/types only and reject traversal, links and hardlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependency-read-"));
  try {
    const pkg = path.join(root, "node_modules/@scope/sdk");
    await mkdir(path.join(pkg, "dist"), { recursive: true });
    await writeFile(path.join(pkg, "package.json"), '{"version":"1.0.0","exports":"./dist/index.js"}');
    await writeFile(path.join(pkg, "dist/index.d.ts"), "export declare const example: string;");
    expect((await readDependency(root, { package: "@scope/sdk", file: "package.json", startLine: 1 })).content).toContain("1.0.0");
    expect((await readDependency(root, { package: "@scope/sdk", file: "dist/index.d.ts", startLine: 1 })).content).toContain("declare");
    for (const file of ["../package.json", ".env", "dist/index.js", "dist/../../package.json", "/package.json"])
      await expect(readDependency(root, { package: "@scope/sdk", file, startLine: 1 })).rejects.toThrow();
    await writeFile(path.join(root, "outside"), "SECRET");
    await symlink(path.join(root, "outside"), path.join(pkg, "linked.d.ts"));
    await expect(readDependency(root, { package: "@scope/sdk", file: "linked.d.ts", startLine: 1 })).rejects.toThrow();
    await link(path.join(root, "outside"), path.join(pkg, "hard.d.ts"));
    await expect(readDependency(root, { package: "@scope/sdk", file: "hard.d.ts", startLine: 1 })).rejects.toThrow();
    await symlink(pkg, path.join(root, "node_modules/alias"));
    await expect(readDependency(root, { package: "alias", file: "package.json", startLine: 1 })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const approve of [true, false]) test(`protected read recovers and dependency approval ${approve} preserves the boundary`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "approval-recovery-"));
  await mkdir(path.join(root, "node_modules/sdk"), { recursive: true });
  await writeFile(path.join(root, "node_modules/sdk/package.json"), '{"version":"9.8.7"}');
  const model = createMockLanguageModel({ streamEvents: [
    [{ type: "tool-call", toolCall: { id: "blocked", name: "read_file", input: { path: "node_modules/sdk/package.json" } } },
      { type: "finish", finishReason: "tool-calls" }],
    [{ type: "tool-call", toolCall: { id: "inspect", name: "read_dependency", input: { package: "sdk" } } },
      { type: "finish", finishReason: "tool-calls" }],
    [{ type: "text-delta", textDelta: "Done with available evidence." }, { type: "finish", finishReason: "stop" }]
  ] });
  const harness = await createHarness({ workspace: root, provider: "meta", modelInstance: model,
    store: createInMemoryAgentRunStore(), subagentProfiles: [], unlimitedTokens: true });
  try {
    const waiting = await runHarness(harness, { prompt: "Inspect SDK.", toolExecution: { stopOnError: false } });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.toolResults[0]?.isError).toBe(true);
    expect(JSON.stringify(waiting.state)).not.toContain("9.8.7");
    const result = await runHarness(harness, { state: waiting.state, toolExecution: { stopOnError: false }, approvals: waiting.state.pendingApprovals.map(a =>
      ({ provider: a.provider, approvalRequestId: a.id, approve })) });
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.state).includes("9.8.7")).toBe(approve);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});

test("protected path errors have a safe actionable terminal cause", () => {
  expect(terminalRunFailure(new Error('Tool "read_file" failed: The path is protected by the harness policy: node_modules')))
    .toBe("read denied · protected path node_modules");
});

test("recoverable reads remain bounded by the tool error budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "approval-error-budget-"));
  const model = createMockLanguageModel({ streamEvents: [1, 2, 3].map(id => [
    { type: "tool-call" as const, toolCall: { id: String(id), name: "read_file", input: { path: "node_modules/sdk/package.json" } } },
    { type: "finish" as const, finishReason: "tool-calls" as const }
  ]) });
  let calls = 0;
  const stream = model.stream!;
  model.stream = input => { calls++; return stream(input); };
  const harness = await createHarness({ workspace: root, provider: "meta", modelInstance: model,
    store: createInMemoryAgentRunStore(), subagentProfiles: [], unlimitedTokens: true, maxToolErrors: 1 });
  try {
    try { expect((await runHarness(harness, { prompt: "Read dependency.", toolExecution: { stopOnError: false } })).status).toBe("failed"); }
    catch (error) { expect(String(error)).toContain("maxToolErrors"); }
    expect(calls).toBeLessThanOrEqual(2);
  } finally { await harness.close(); await rm(root, { recursive: true, force: true }); }
});
