import { expect, test } from "bun:test";
import { requestSchema } from "../scripts/swebench/zhivex-driver.js";

test("external driver rejects gold evaluation material and unpinned images", () => {
  const request = { schemaVersion: 1, runToken: "a".repeat(32), workspace: "/tmp/test", instanceId: "org__repo-1",
    problem: "Fix it", image: `sha256:${"a".repeat(64)}`, model: "model",
    limits: { steps: 24, outputPerTurn: 2048, inputTokens: 100000, outputTokens: 16000,
      timeoutSeconds: 300, memoryMb: 2048, cpus: 2 } };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(requestSchema.safeParse({ ...request, test_patch: "hidden" }).success).toBe(false);
  expect(requestSchema.safeParse({ ...request, image: "image:latest" }).success).toBe(false);
  expect(requestSchema.safeParse({ ...request, instanceId: "../../escape" }).success).toBe(false);
});

test("comparison contracts retain failures, reject duplicates, and distinguish missing costs", async () => {
  const child = Bun.spawn([process.env.ZHIVEX_SWEBENCH_PYTHON ?? "python3", "scripts/swebench/test_contracts.py"], {
    stdout: "pipe", stderr: "pipe"
  });
  const output = await new Response(child.stderr).text();
  expect(await child.exited, output).toBe(0);
});

import { projectState, sanitizeOperationalError } from "../scripts/swebench/telemetry.js";
import type { AgentStep } from "@zhivex-ai/agents";

test("partial telemetry retains measured usage once and excludes raw content", () => {
  const step: AgentStep = { index: 0, status: "completed", request: { messages: [] },
    response: { messages: [], usage: { inputTokens: 50, outputTokens: 7, totalTokens: 57 } },
    toolResults: [{ toolCallId: "id", toolName: "read_files", output: "PRIVATE_CONTENT", isError: false }] };
  const observed = new Map([[0, step]]);
  observed.set(0, step);
  const result = projectState(undefined, observed);
  expect(result.inputTokens).toBe(50);
  expect(result.modelCalls).toBe(1);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTENT");
  observed.set(1, { ...step, index: 1, response: { messages: [] } });
  expect(projectState(undefined, observed).usageComplete).toBe(false);
  const diagnostic = sanitizeOperationalError(new Error("PRIVATE_CONTENT timeout", { cause: new Error("PRIVATE_KEY") }));
  expect(diagnostic.chain[0]?.reason).toBe("timeout");
  expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
});

import { createModelBudget } from "../scripts/swebench/model-budget.js";
import { projectStep } from "../scripts/swebench/telemetry.js";

test("verification telemetry retains typed outcomes without exposing command output", () => {
  const result = projectStep({ index: 1, status: "completed", request: { messages: [] }, toolResults: [{
    toolName: "verify_and_apply_environment_patch", isError: false,
    output: { verification: { exitCode: 1, timedOut: false, stdout: "private stdout", command: ["private arg"] } }
  }] } as never);
  expect(result.tools[0]).toMatchObject({ exitCode: 1, timedOut: false });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("message-only verifier failures retain the exit code without accepting arbitrary output", () => {
  const message = (exit: string) => `The approved verifier failed with exit code ${exit}; the host workspace was not changed.`;
  const diagnostic = sanitizeOperationalError({ message: message("1"), stdout: "PRIVATE", stderr: "PRIVATE" });
  expect(diagnostic.chain[0]?.verifierExitCode).toBe(1);
  expect(diagnostic.chain[0]?.fingerprint).toBe("d22955ecb1810cd7e960e732636eec570e04ab3b19eab276ebf23e2096a3c941");
  expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
  for (const text of [message("0"), message("256"), message("-1"), message("01"), message("1") + " PRIVATE", "PRIVATE " + message("1")]) {
    expect(sanitizeOperationalError({ message: text }).chain[0]?.verifierExitCode).toBeNull();
  }
  expect(sanitizeOperationalError(new Error("wrapper", { cause: { message: message("124") } })).chain[1]?.verifierExitCode).toBe(124);
});

test("verifier output hints are bounded fixed markers, never raw diagnoses", () => {
  const project = (toolName: string, verification: unknown) => projectStep({ index: 1, status: "completed", request: { messages: [] },
    toolResults: [{ toolName, isError: true, output: { verification } }] } as never);
  const result = project("verify_and_apply_environment_patch", { exitCode: 1, diagnostics: {
    stderr: "Traceback PRIVATE_PATH\nModuleNotFoundError: No module named PRIVATE_MODULE\nAssertionError: PRIVATE_ASSERTION", stdout: "" } });
  expect(result.tools[0]?.verificationHints).toEqual(["ModuleNotFoundError", "AssertionError"]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  const unrelated = project("read_file", { stderr: "AssertionError: PRIVATE" });
  expect(unrelated.tools[0]?.verificationHints).toBeUndefined();
  const embedded = project("verify_and_apply_environment_patch", { stderr: "print('AssertionError: PRIVATE')" });
  expect(embedded.tools[0]?.verificationHints).toBeUndefined();
  const huge = project("verify_and_apply_environment_patch", { stderr: "x".repeat(5000) + "\nNameError: PRIVATE\n" + "x".repeat(5000) + "\nSyntaxError: PRIVATE" });
  expect(huge.tools[0]?.verificationHints).toEqual(["SyntaxError"]);
  expect(JSON.stringify(huge)).not.toContain("PRIVATE");
});

test("budget prediction leaves the durable message array unchanged", async () => {
  const budget = createModelBudget({ inputTokens: 1000, outputTokens: 100 });
  budget.stats.inputTokens = 60;
  const original: [] = [];
  const context = { input: { messages: original }, model: {} };
  await budget.middleware.wrapGenerate!(context as never, async () => ({ usage: { inputTokens: 5, outputTokens: 1 } }) as never);
  expect(original).toHaveLength(0);
  expect(context.input.messages).toBe(original);
  expect(budget.stats.predictedInputTokens).toBe(64);
});

test("model boundary blocks another request after the real cumulative ceiling", async () => {
  const budget = createModelBudget({ inputTokens: 100, outputTokens: 100 }, { closure: () => true });
  let calls = 0;
  const next = async () => { calls++; return (async function* () {
    yield { type: "finish" as const, finishReason: "stop" as const, usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 } };
  })(); };
  const context = { input: { messages: [] }, model: {} } as never;
  for await (const _ of await budget.middleware.wrapStream!(context, next)) { /* drain */ }
  await expect(budget.middleware.wrapStream!(context, next)).rejects.toThrow("INPUT_TOKEN_BUDGET");
  expect(calls).toBe(1);
  expect(budget.stats.inputTokens).toBe(100);
  expect(budget.stats.usageComplete).toBe(true);
});

test("candidate diagnostics use a separate checkout with digest and path binding", async () => {
  const child = Bun.spawn([process.env.ZHIVEX_SWEBENCH_PYTHON ?? "python3", "scripts/swebench/test_candidate.py"], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});

test("typed parsing failures and requested tools survive sanitized telemetry", () => {
  const diagnostic = sanitizeOperationalError({ name: "ParseError", message: "private payload", cause: { name: "SyntaxError", message: "private token" } });
  expect(diagnostic.failureType).toBe("parsing");
  expect(diagnostic.chain[0]?.errorClass).toBe("ParseError");
  expect(JSON.stringify(diagnostic)).not.toContain("private");
  const step = projectStep({ index: 1, status: "failed", request: { messages: [] }, toolResults: [], response: { finishReason: "tool-calls", messages: [{ role: "assistant", parts: [
    { type: "tool-call", toolCall: { id: "private-id", name: "verify_and_apply_environment_patch", input: { command: "private-command" } } },
    { type: "tool-call", toolCall: { id: "private-id2", name: "private-custom-name", input: {} } }
  ] }] } } as never);
  expect(step.requestedTools).toEqual(["verify_and_apply_environment_patch", "other-tool"]);
  expect(JSON.stringify(step)).not.toContain("private");
});

test("model setup failures keep latency and unknown usage without inventing tokens", async () => {
  const budget = createModelBudget({ inputTokens: 100, outputTokens: 100 });
  await expect(budget.middleware.wrapStream!({ input: { messages: [] }, model: {} } as never, async () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
  expect(budget.modelTimings).toHaveLength(1);
  expect(budget.modelTimings[0]).toMatchObject({ firstTokenMs: null, completed: false });
  expect(budget.stats.usageComplete).toBe(false);
});
