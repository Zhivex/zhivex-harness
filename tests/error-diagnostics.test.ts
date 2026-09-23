import { expect, test } from "bun:test";
import { Agent, GuardrailTriggeredError, ProviderToolCallError, ValidationError, createTextMessage, createInMemoryAgentRunStore } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { errorDetailsSchema, sanitizedErrorDetails } from "../src/runtime/error-diagnostics.js";
import { sanitizeOperationalError, restoreSanitizedOperationalError } from "../scripts/release-diagnostics.js";

const secret = "PRIVATE_PROMPT_ARGUMENT_RESPONSE";

test("wrapped provider tool JSON failures preserve the reason and SyntaxError without their contents", () => {
  const error = new Error(secret, { cause: new ProviderToolCallError({
    provider: "qwen", transport: "chat", diagnosticCode: "QWEN_CHAT_TOOL_CALL_INVALID",
    reason: "invalid_json", cause: new SyntaxError(secret)
  }) });
  const safe = sanitizeOperationalError(error);
  expect(safe.details?.chain).toEqual([
    { kind: "Error" },
    { kind: "ProviderToolCallError", category: "provider-tool-call", providerToolCallReason: "invalid_json", retryable: false, effectsPossible: false },
    { kind: "SyntaxError" }
  ]);
  expect(JSON.stringify(safe)).not.toContain(secret);
  expect(sanitizeOperationalError(restoreSanitizedOperationalError(safe))).toEqual(safe);
});

test("SDK durable provider failures preserve finite category and reason without an Error name", async () => {
  const store = createInMemoryAgentRunStore();
  const mock = createMockLanguageModel({ responses: [] });
  const agent = new Agent({ store, model: { ...mock, generate: async () => {
    throw new ProviderToolCallError({ provider: "qwen", transport: "chat",
      diagnosticCode: "QWEN_CHAT_TOOL_CALL_INVALID", reason: "invalid_json" });
  } } });
  await expect(agent.run({ runId: "durable-provider-failure", prompt: secret })).rejects.toThrow();
  const durable = (await store.load("durable-provider-failure"))?.error;
  expect(durable).toMatchObject({ category: "provider-tool-call", reason: "invalid_json" });
  expect(durable).not.toHaveProperty("name");
  const details = sanitizedErrorDetails(durable);
  expect(details.chain).toEqual([{ category: "provider-tool-call", providerToolCallReason: "invalid_json", retryable: false, effectsPossible: false }]);
  const safe = sanitizeOperationalError(durable);
  expect(safe.details).toEqual(details);
  expect(sanitizeOperationalError(restoreSanitizedOperationalError(safe))).toEqual(safe);
  expect(JSON.stringify(safe)).not.toContain(secret);
  expect(sanitizedErrorDetails({ category: secret, reason: "invalid_json", message: secret })).toEqual({ chain: [] });
  expect(sanitizedErrorDetails({ category: "provider-tool-call", reason: secret, effectsPossible: secret, message: secret }))
    .toEqual({ chain: [{ category: "provider-tool-call" }] });
});

test("provider and guardrail diagnostics accept only their finite reason/stage fields", () => {
  expect(sanitizedErrorDetails({ name: "ProviderToolCallError", reason: secret, effectsPossible: secret, message: secret })).toEqual({ chain: [{ kind: "ProviderToolCallError" }] });
  expect(sanitizedErrorDetails(new GuardrailTriggeredError("tool-input", secret))).toEqual({ chain: [{ kind: "GuardrailTriggeredError", guardrailStage: "tool-input" }] });
  expect(sanitizedErrorDetails({ name: "GuardrailTriggeredError", stage: secret })).toEqual({ chain: [{ kind: "GuardrailTriggeredError" }] });
  expect(errorDetailsSchema.safeParse({ chain: [{ providerToolCallReason: secret }] }).success).toBe(false);
  expect(errorDetailsSchema.safeParse({ chain: [{ compactionReason: secret }] }).success).toBe(false);
});

test("compaction classification requires an exact SDK validation error message", () => {
  const message = "Agent compaction cannot satisfy its limits without removing protected messages.";
  expect(sanitizedErrorDetails(new ValidationError(message))).toEqual({ chain: [{ kind: "ValidationError", compactionReason: "protected_messages" }] });
  expect(sanitizedErrorDetails(new Error(message))).toEqual({ chain: [{ kind: "Error" }] });
  expect(sanitizedErrorDetails(new ValidationError(`${message} ${secret}`))).toEqual({ chain: [{ kind: "ValidationError" }] });
});

test("actual SDK compactor failure survives operational serialization as an empty-summary reason", async () => {
  const agent = new Agent({ model: createMockLanguageModel({ responses: [] }),
    compaction: { maxMessages: 2, keepRecentMessages: 1, compactor: () => ({ summary: " " }) }
  });
  let failure: unknown;
  try {
    await agent.run({ messages: [createTextMessage("user", secret), createTextMessage("assistant", secret), createTextMessage("user", secret)] });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ValidationError);
  const safe = sanitizeOperationalError(failure);
  expect(safe.details?.chain).toEqual([{ kind: "ValidationError", compactionReason: "empty_summary" }]);
  expect(sanitizeOperationalError(restoreSanitizedOperationalError(safe))).toEqual(safe);
  expect(JSON.stringify(safe)).not.toContain(secret);
});
