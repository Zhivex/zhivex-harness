import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { GENERAL_ASSISTANT_PROFILE } from "@zhivex-ai/harness/engine";
import { startAssistantHost } from "../../dist/index.js";

const [directory, mode, recover] = process.argv.slice(2);
const model = createMockLanguageModel({ streamEvents: mode === "propose" ? [[
  { type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: {
    path: "note.txt", expectedDigest: "sha256:" + createHash("sha256").update("before").digest("hex"), oldText: "before", newText: "after"
  } } }, { type: "finish", finishReason: "tool-calls" }
], [{ type: "text-delta", textDelta: "Updated" }, { type: "finish", finishReason: "stop" }]] : [[
  { type: "text-delta", textDelta: "Remembered" }, { type: "finish", finishReason: "stop" }
]] });
const stream = model.stream.bind(model);
model.stream = async input => {
  await writeFile(directory + "/model-input.json", JSON.stringify(input));
  return stream(input);
};
try {
  const host = await startAssistantHost({ directory, ownerId: "owner", recover: recover === "recover", engine: {
    modelInstance: model, agentProfile: { ...GENERAL_ASSISTANT_PROFILE, toolNames: ["apply_reviewed_replacement"] }
  } });
  console.log(JSON.stringify({ credentialsPath: host.credentialsPath }));
  const stop = () => { void host.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
} catch (error) { console.error(error.message); process.exitCode = 1; }
