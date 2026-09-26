import { expect, test } from "bun:test";
import { tool } from "@zhivex-ai/core";
import { z } from "zod";
import { createProgressMonitor, PROGRESS_MONITOR_KEY } from "../src/runtime/progress-monitor.js";

test("repeated edit-test cycles recommend recovery then stop without storing payloads", () => {
  const monitor = createProgressMonitor();
  for (let i = 0; i < 5; i++) {
    monitor.observeTool("edit", { source: "PRIVATE" }, "same digest");
    monitor.observeTool("test", {}, "same error", { failed: true });
    if (i === 1) expect(monitor.check().action).toBe("continue");
    if (i === 2) expect(monitor.check()).toEqual({ action: "recover", repetitions: 3, cycleLength: 2 });
  }
  expect(monitor.check().action).toBe("stop");
  expect(JSON.stringify(monitor.snapshot())).not.toContain("PRIVATE");
});

test("changed results, revision or explicit progress break repetition", () => {
  const monitor = createProgressMonitor();
  for (let i = 0; i < 20; i++) monitor.observeTool("read", {}, { content: i });
  expect(monitor.check().action).toBe("continue");
  for (let i = 0; i < 20; i++) monitor.observeTool("command", {}, "ok", { revision: String(i) });
  expect(monitor.check().action).toBe("continue");
  for (let i = 0; i < 5; i++) monitor.observeTool("read", {}, "same");
  expect(monitor.check().action).toBe("stop");
  monitor.markProgress();
  expect(monitor.check().action).toBe("continue");
});

test("bounded durable state detects loops across resume and ignores short text", () => {
  const metadata: Record<string, unknown> = {};
  const monitor = createProgressMonitor(metadata);
  for (let i = 0; i < 100; i++) monitor.observeTool("read", {}, i);
  expect(monitor.snapshot().history).toHaveLength(64);
  monitor.markProgress();
  const text = "I will investigate this failure and inspect the same code to determine why the test is still failing.";
  monitor.observeText(text); monitor.observeText(text);
  const resumed = createProgressMonitor(JSON.parse(JSON.stringify(metadata)));
  resumed.observeText(text.replaceAll(" ", "  "));
  expect(resumed.check().action).toBe("recover");
  resumed.markProgress();
  for (let i = 0; i < 20; i++) resumed.observeText("OK");
  expect(resumed.check().action).toBe("continue");
  expect(() => createProgressMonitor({ [PROGRESS_MONITOR_KEY]: { version: 1, history: ["raw secret"] } })).toThrow();
});

test("wrappers retain every effect, original result/error, approval and independence flags", async () => {
  let effects = 0;
  const failure = new Error("failed after mutation");
  const metadata = {};
  const monitor = createProgressMonitor(metadata);
  const tools = monitor.wrapTools({ mutate: tool({ name: "mutate", schema: z.object({ fail: z.boolean() }),
    requiresApproval: true, approvalMode: "interrupt", independent: false,
    execute: async ({ fail }) => { effects++; if (fail) throw failure; return { ok: true }; } }) });
  const wrapped = tools.mutate as any;
  for (let i = 0; i < 8; i++) expect(await wrapped.execute({ fail: false }, { metadata })).toEqual({ ok: true });
  expect(monitor.check().action).toBe("stop");
  expect(effects).toBe(8);
  for (let i = 0; i < 5; i++) await expect(wrapped.execute({ fail: true }, { metadata })).rejects.toBe(failure);
  expect(effects).toBe(13);
  expect(wrapped).toMatchObject({ requiresApproval: true, approvalMode: "interrupt", independent: false });
  expect(createProgressMonitor(metadata).check().action).toBe("stop");
});

test("argument key order does not hide repeated operations", () => {
  const monitor = createProgressMonitor();
  monitor.observeTool("read", { a: 1, b: 2 }, "same");
  monitor.observeTool("read", { b: 2, a: 1 }, "same");
  monitor.observeTool("read", { a: 1, b: 2 }, "same");
  expect(monitor.check().action).toBe("recover");
});

test("non-JSON custom results cannot turn a successful effect into an error", async () => {
  const monitor = createProgressMonitor();
  const result: any = { value: 1n };
  const tools = monitor.wrapTools({ custom: tool({ name: "custom", schema: z.object({}), execute: async () => result }) });
  expect(await (tools.custom as any).execute({})).toBe(result);
  expect(monitor.check().action).toBe("continue");
});

test("varied exploration advises durably without a hard stop or retaining payloads", () => {
  let monitor = createProgressMonitor();
  for (let index = 0; index < 40; index++) {
    monitor.observeTool(index % 2 ? "read_file" : "search_files", { path: `private-${index}` }, { content: index });
    if (index === 6) expect(monitor.needsExplorationDecision()).toBe(false);
    if (index >= 7) expect(monitor.needsExplorationDecision()).toBe(true);
    monitor = createProgressMonitor({ [PROGRESS_MONITOR_KEY]: JSON.parse(JSON.stringify(monitor.snapshot())) });
    expect(monitor.check().action).toBe("continue");
  }
  expect(monitor.snapshot().exploration).toBe(8);
  expect(JSON.stringify(monitor.snapshot())).not.toContain("private-");
  monitor.markProgress();
  expect(monitor.needsExplorationDecision()).toBe(false);
});

test("only successful edits and checks reset exploration; legacy metadata remains readable", () => {
  const monitor = createProgressMonitor({ [PROGRESS_MONITOR_KEY]: { version: 1, history: [] } });
  for (let index = 0; index < 8; index++) monitor.observeTool("read_dependency", { file: String(index) }, "not found", { failed: true });
  monitor.observeTool("apply_patch", {}, "denied", { failed: true });
  monitor.observeTool("run_check", {}, { exitCode: 1 });
  monitor.observeTool("run_check", {}, { exitCode: 0, timedOut: true });
  monitor.observeTool("apply_patch", {}, { success: false });
  monitor.observeTool("propose_edits", {}, { changes: [] });
  expect(monitor.needsExplorationDecision()).toBe(true);
  monitor.observeTool("run_check", {}, { exitCode: 0 });
  expect(monitor.needsExplorationDecision()).toBe(false);
  for (let index = 0; index < 8; index++) monitor.observeTool("read_file", { path: String(index) }, "text");
  monitor.observeTool("apply_reviewed_replacement", {}, { changed: true });
  expect(monitor.needsExplorationDecision()).toBe(false);
  // Exact-cycle safeguards are independent of an edit's successful return.
  for (let index = 0; index < 5; index++) monitor.observeTool("apply_patch", {}, { changed: true });
  expect(monitor.check().action).toBe("stop");
});
