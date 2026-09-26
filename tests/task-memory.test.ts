import { expect, test } from "bun:test";
import { createTextMessage, type ToolExecutionContext } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { captureTaskSources, createTaskTools, TASK_SOURCE_KEY } from "../src/context/task-memory.js";

test("operator history beyond 64 requests stays durable while read_task projects a bounded recent page", async () => {
  const original = "Keep the public API and Unicode ordering.";
  const sources = captureTaskSources({}, [createTextMessage("user", original),
    ...Array.from({ length: 70 }, (_, index) => createTextMessage("user", `Investigate module ${index}; preserve earlier constraints.`))]);
  const metadata = JSON.parse(JSON.stringify({ [TASK_SOURCE_KEY]: sources }));
  const tool = createTaskTools().read_task;
  const context = { metadata } as ToolExecutionContext;
  const latest = await tool.execute(tool.schema.parse({}), context);
  expect(latest.totalSources).toBe(71);
  expect(latest.sourceIds).toHaveLength(64);
  expect(latest.sourceOffset).toBe(7);
  expect(latest.content).toContain("module 69");
  expect(latest.firstSourceId).toBe(sources[0]!.id);
  const first = await tool.execute(tool.schema.parse({ id: latest.firstSourceId, sourceOffset: 0 }), context);
  expect(first.content).toBe(original);
  expect(first.sourceIds[0]).toBe(sources[0]!.id);
  expect(first.nextSourceOffset).toBe(64);
  const continuation = captureTaskSources(metadata, [createTextMessage("user", "Correction: preserve sorting by code point.")]);
  expect(continuation).toHaveLength(72);
  expect(continuation[0]!.text).toBe(original);
  expect(continuation.at(-1)!.text).toContain("Correction");
});

test("large operator requests are redacted durably and read in bounded text pages", async () => {
  const text = `TOKEN_SECRET=private-value\n${"Unicode requirements. ".repeat(14_000)}Final acceptance criterion.`;
  const sources = captureTaskSources({}, [createTextMessage("user", text)]);
  expect(sources[0]!.text.length).toBeGreaterThan(256_000);
  expect(sources[0]!.text).not.toContain("private-value");
  const tool = createTaskTools().read_task;
  const context: ToolExecutionContext = { metadata: { [TASK_SOURCE_KEY]: sources },
    toolCall: { id: "task", name: "read_task", input: {} }, step: 0, model: createMockLanguageModel() };
  const page = await tool.execute(tool.schema.parse({}), context);
  expect(page.content).toHaveLength(4000);
  expect(page.nextOffset).toBe(4000);
  const tail = await tool.execute(tool.schema.parse({ offset: page.totalCharacters - 100 }), context);
  expect(tail.content).toContain("Final acceptance criterion");
  expect(tail.nextOffset).toBeNull();
});

test("A to B to A restores the latest request without duplicates or losing the original identity", async () => {
  const history = [createTextMessage("user", "Inspect the parser."), createTextMessage("user", "Review the cache.")];
  const first = captureTaskSources({}, history);
  const originalId = first[0]!.id;
  const latest = captureTaskSources({ [TASK_SOURCE_KEY]: first }, [history[0]!]);
  expect(latest).toHaveLength(2);
  expect(latest.at(-1)!.text).toBe("Inspect the parser.");
  const recaptured = captureTaskSources(JSON.parse(JSON.stringify({ [TASK_SOURCE_KEY]: latest })), [...history, history[0]!]);
  expect(recaptured).toEqual(latest);
  const task = createTaskTools().read_task;
  const context: ToolExecutionContext = { metadata: { [TASK_SOURCE_KEY]: recaptured },
    toolCall: { id: "task", name: "read_task", input: {} }, step: 0, model: createMockLanguageModel() };
  const page = await task.execute(task.schema.parse({}), context);
  expect(page.content).toBe("Inspect the parser.");
  expect(page.firstSourceId).toBe(originalId);
  expect(page.sourceIds).toEqual([first[1]!.id, originalId]);
  // Older durable records without a marker still preserve their first request.
  const migrated = captureTaskSources({ [TASK_SOURCE_KEY]: first.map(({ id, text }) => ({ id, text })) }, [history[0]!]);
  expect(migrated).toEqual(latest);
});
