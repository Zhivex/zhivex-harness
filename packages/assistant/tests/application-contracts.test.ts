import { expect, test } from "bun:test";
import { ASSISTANT_APPLICATION_PROTOCOL_VERSION } from "../src/application-contracts.js";
import type { AssistantApplicationEngineCommand, AssistantApplicationClient, AssistantExecutionContext } from "../src/application-contracts.js";
import type { HarnessClientCommand } from "@zhivex-ai/harness/protocol";

// Checked by tsc as well as the test runner. No host is instantiated in stage zero.
function compileBoundary(client: AssistantApplicationClient) {
  const context: AssistantExecutionContext = { kind: "project", projectKey: "registered-project" };
  void client.createConversation({ context, idempotencyKey: "request-1" });
  void client.registerProject({ selectionToken: "native-selection" });
  // @ts-expect-error arbitrary renderer paths cannot register a project
  void client.registerProject({ path: "/tmp/repository" });
  // @ts-expect-error project contexts require a project binding
  const missingProject: AssistantExecutionContext = { kind: "project" };
  const cancel: AssistantApplicationEngineCommand = {
    method: "run.cancel", sessionId: "session", runId: "run", expectedRevision: 1, idempotencyKey: "cancel-1",
  };
  void client.command({ conversationId: "conversation", command: cancel });
  // @ts-expect-error routing cannot be overridden by supplying an engine project ID
  const wrongScope: AssistantApplicationEngineCommand = { ...cancel, projectId: "another-project" };
  const approval = {} as Extract<HarnessClientCommand, { method: "approval.resolve" }>;
  // @ts-expect-error effect decisions must use a concrete trusted review receipt
  void client.command({ conversationId: "conversation", command: approval });
  const restore = {} as Extract<HarnessClientCommand, { method: "restore.apply" }>;
  // @ts-expect-error restoration cannot bypass reviewed dispatch
  void client.command({ conversationId: "conversation", command: restore });
  const keep: AssistantApplicationEngineCommand = {
    method: "task.keep", sessionId: "session", runId: "run", idempotencyKey: "keep-1", reviewId: "review",
  };
  void client.command({ conversationId: "conversation", command: keep });
  void [missingProject, wrongScope];
}

test("application contract version is independent of enabling a host adapter", () => {
  expect(ASSISTANT_APPLICATION_PROTOCOL_VERSION).toBe(1);
  expect(typeof compileBoundary).toBe("function");
});
