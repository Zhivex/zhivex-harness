import { createHash } from "node:crypto";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { startAssistantHost } from "../../dist/index.js";

const [directory, project, mode] = process.argv.slice(2);
const model = createMockLanguageModel({ streamEvents: [[
  { type: "tool-call", toolCall: { id: "edit", name: "apply_reviewed_replacement", input: {
    path: "note.txt", expectedDigest: "sha256:" + createHash("sha256").update("before").digest("hex"), oldText: "before", newText: "after",
  } } }, { type: "finish", finishReason: "tool-calls" },
]] });
try {
  const host = await startAssistantHost({ directory, ownerId: "owner", recover: mode === "recover", engine: { modelInstance: createMockLanguageModel() },
    coding: { execution: "local", configurationId: "process-fixture-v1", engine: { provider: "openai", modelInstance: model } } });
  const app = host.application;
  const registration = await app.client.registerProject(await app.selectProject(project));
  if (!registration.ok) throw new Error(registration.error.code);
  const connection = await app.projectConnection(registration.data.projectKey);
  if (mode === "propose") {
    const conversation = await app.client.createConversation({ context: { kind: "project", projectKey: registration.data.projectKey }, idempotencyKey: "create" });
    if (!conversation.ok) throw new Error(conversation.error.code);
    const view = await app.client.snapshot(conversation.data.conversationId);
    if (!view.ok) throw new Error(view.error.code);
    const run = await app.client.command({ conversationId: conversation.data.conversationId, command: { method: "run.start", sessionId: conversation.data.sessionId, expectedRevision: view.data.session.revision, idempotencyKey: "start", prompt: "Update the note" } });
    if (!run.ok || !run.data.ok) throw new Error("fixture run failed");
  }
  console.log(JSON.stringify(connection));
  const stop = () => void host.close().catch(() => { process.exitCode = 1; });
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
} catch (error) { console.error(error.message); process.exit(1); }
