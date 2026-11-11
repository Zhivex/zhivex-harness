import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createAssistantRuntime } from "../dist/index.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "assistant-offline-"));
let runtime;
try {
  runtime = await createAssistantRuntime({ workspace, ownerId: "local-owner",
    modelInstance: createMockLanguageModel({ streamEvents: [[
      { type: "text-delta", textDelta: "Assistant bootstrap OK" },
      { type: "finish", finishReason: "stop" }
    ]] }) });
  const result = await runtime.runTask("Confirm the bootstrap.");
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Assistant bootstrap OK");
  assert.ok(result.runId);
  console.log(JSON.stringify({ check: "assistant-offline", ...result }));
} finally {
  await runtime?.close();
  await rm(workspace, { recursive: true, force: true });
}
