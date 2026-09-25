import { expect, test } from "bun:test";
import { createMockLanguageModel, streamText, tool, type ToolSet } from "@zhivex-ai/core";
import { z } from "zod";
import { scheduleLocalReads } from "../src/runtime/tool-scheduling.js";

test("only host-owned local reads can claim independence", () => {
  const make = (name: string, extra = {}) => tool({ name, schema: z.object({}), execute: async () => "ok", independent: true, ...extra });
  const local = { read_file: make("read_file"), read_files: make("read_files", { requiresApproval: true }), apply_patch: make("apply_patch") };
  const tools = { ...local, remote: make("remote"), search_files: make("search_files", { metadata: { type: "subagent" } }) };
  const scheduled = scheduleLocalReads(tools, local);
  expect((scheduled.tools.read_file as any).independent).toBe(true);
  for (const name of ["read_files", "apply_patch", "remote", "search_files"]) expect((scheduled.tools[name] as any).independent).toBe(false);
  const spoofed = scheduleLocalReads({ read_file: make("read_file") }, local);
  expect((spoofed.tools.read_file as any).independent).toBe(false);
  expect(scheduled.toolExecution).toEqual({ parallel: true, independentOnly: true, maxConcurrency: 4 });
  for (const limit of [0, 9, 1.5, Infinity]) expect(() => scheduleLocalReads({}, {}, limit)).toThrow();
});

test("installed SDK overlaps reads, bounds workers and respects mutation barriers", async () => {
  let active = 0, peak = 0;
  const order: string[] = [];
  const tools: ToolSet = {};
  for (const name of ["read_file", "read_files", "search_files", "apply_patch", "search_many"]) {
    tools[name] = tool({ name, schema: z.object({}), execute: async () => {
      if (name === "apply_patch") expect(active).toBe(0);
      active++; peak = Math.max(peak, active); order.push(`start:${name}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push(`end:${name}`); active--; return name;
    } });
  }
  const scheduled = scheduleLocalReads(tools, tools, 2);
  const model = createMockLanguageModel({ streamEvents: [[
    ...Object.keys(tools).map((name, index) => ({ type: "tool-call" as const, toolCall: { id: String(index), name, input: {} } })),
    { type: "finish" as const, finishReason: "tool-calls" as const }
  ], [{ type: "text-delta", textDelta: "done" }, { type: "finish", finishReason: "stop" }]] });
  await streamText({ model, prompt: "run", ...scheduled, maxSteps: 2 }).collect();
  expect(peak).toBe(2);
  expect(order.indexOf("start:apply_patch")).toBeGreaterThan(order.indexOf("end:search_files"));
  expect(order.indexOf("start:search_many")).toBeGreaterThan(order.indexOf("end:apply_patch"));
});
