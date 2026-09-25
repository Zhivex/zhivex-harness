import { expect, test } from "bun:test";
import { tool } from "@zhivex-ai/agents";
import { z } from "zod";
import { applyHarnessToolPolicy, createHarnessToolPolicy, type HarnessToolPolicy } from "../src/runtime/tool-policy.js";

const policy: HarnessToolPolicy = { schemaVersion: 1, rules: [
  { id: "permit", tools: ["read"], decision: "allow", reason: "Ordinary read" },
  { id: "review", tools: ["read"], paths: ["src/a.ts"], decision: "ask_user", reason: "Review source" },
  { id: "block", tools: ["read"], paths: ["private.txt"], decision: "deny", reason: "Private file" }
] };

test("policy takes most restrictive decision across all targets and retains approval floor", () => {
  const engine = createHarnessToolPolicy(policy);
  expect(engine.evaluate({ toolName: "read", paths: ["public.txt"] }).decision).toBe("allow");
  expect(engine.evaluate({ toolName: "read", paths: ["src/a.ts"] }).decision).toBe("ask_user");
  expect(engine.evaluate({ toolName: "read", paths: ["public.txt", "private.txt"] }).ruleIds).toEqual(["block"]);
  expect(engine.evaluate({ toolName: "read", paths: ["public.txt"], requiresApproval: true }).decision).toBe("ask_user");
  expect(engine.evaluate({ toolName: "read", hardDenied: true }).decision).toBe("deny");
  expect(engine.evaluate({ toolName: "read" }).decision).toBe("deny");
  expect(engine.evaluate({ toolName: "read_more", paths: ["private.txt"] }).decision).toBe("allow");
  expect(engine.evaluate({ toolName: "read", paths: ["private.txt.more"] }).decision).toBe("allow");
  expect(() => engine.evaluate({ toolName: "read", paths: ["src/../private.txt"] })).toThrow();
});

test("digest is canonical and caller mutation cannot modify compiled policy", () => {
  const input = structuredClone(policy);
  const engine = createHarnessToolPolicy(input);
  expect(createHarnessToolPolicy({ schemaVersion: 1, rules: [...policy.rules].reverse() }).digest).toBe(engine.digest);
  input.rules.length = 0;
  engine.policy.rules.length = 0;
  expect(engine.evaluate({ toolName: "read", paths: ["private.txt"] }).decision).toBe("deny");
});

test("wrapper blocks before execution and conservatively lifts static approval metadata", async () => {
  let executions = 0;
  const tools = { read: tool({ name: "read", schema: z.object({ path: z.string() }), execute: async () => { executions++; return "ok"; } }) };
  expect(() => applyHarnessToolPolicy(tools, policy)).toThrow("resolvePaths");
  const wrapped = applyHarnessToolPolicy(tools, policy, { resolvePaths: (_name, input) => [(input as { path: string }).path] });
  const read = wrapped.read!;
  expect(read.requiresApproval).toBe(true);
  if (!("execute" in read) || !read.execute) throw new Error("Missing executor");
  await expect(read.execute({ path: "private.txt" }, {} as never)).rejects.toThrow("block");
  expect(executions).toBe(0);
  expect(await read.execute({ path: "public.txt" }, {} as never)).toBe("ok");
  expect(executions).toBe(1);
});

test("allow cannot clear existing approval or bypass underlying hard checks", async () => {
  const tools = { read: tool({ name: "read", schema: z.object({}), requiresApproval: true,
    execute: async (): Promise<string> => { throw new Error("Hard boundary"); } }) };
  const wrapped = applyHarnessToolPolicy(tools, { schemaVersion: 1, rules: [policy.rules[0]!] });
  expect(wrapped.read?.requiresApproval).toBe(true);
  const read = wrapped.read!;
  if (!("execute" in read) || !read.execute) throw new Error("Missing executor");
  await expect(read.execute({}, {} as never)).rejects.toThrow("Hard boundary");
});

test("rejects unbounded, duplicate and pattern matching policy", () => {
  expect(() => createHarnessToolPolicy({ schemaVersion: 1, rules: [policy.rules[0]!, policy.rules[0]!] })).toThrow();
  expect(() => createHarnessToolPolicy({ schemaVersion: 1, rules: [{ ...policy.rules[0]!, tools: ["run_*"] }] })).toThrow();
});
