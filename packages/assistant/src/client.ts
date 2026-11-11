import { randomUUID } from "node:crypto";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "@zhivex-ai/harness/service";
import type { HarnessClientCommand } from "@zhivex-ai/harness/protocol";

type WithoutProject<T> = T extends unknown ? Omit<T, "projectId"> : never;
export type AssistantCommand = WithoutProject<HarnessClientCommand>;

/** Local trusted client; reconnect after restart, then inspect before any mutation retry. */
export async function connectAssistant(credentialsPath: string) {
  const credentials = await readHarnessLocalCredentials(credentialsPath);
  const hello = await requestHarnessLocalService(credentials, "hello", { versions: [1] });
  if (!hello.ok) throw new Error(hello.error.code);
  let pending: Promise<unknown> = Promise.resolve();
  const dispatch = (command: AssistantCommand) => requestHarnessLocalService(credentials, "command", {
    protocolVersion: 1, requestId: randomUUID(), connectionId: hello.connectionId,
    command: { ...command, projectId: hello.projectId }
  });
  return {
    projectId: hello.projectId,
    command(command: AssistantCommand) {
      // Reads/cancellation must stay available while a mutation waits on a provider.
      if (command.method.endsWith(".get") || command.method.endsWith(".list") || command.method === "run.cancel") return dispatch(command);
      const result = pending.then(() => dispatch(command));
      pending = result.then(() => {}, () => {});
      return result;
    },
    events(sessionId: string, after = 0) {
      return requestHarnessLocalService(credentials, "events", { projectId: hello.projectId, sessionId, after });
    }
  };
}
