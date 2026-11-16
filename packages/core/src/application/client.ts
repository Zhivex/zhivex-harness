import { randomUUID } from "node:crypto";
import { readHarnessLocalCredentials, requestHarnessLocalService, requestLocalServiceDocument } from "../client/local-transport.js";
import { harnessClientRequestSchema, type HarnessClientResponse, type HarnessClientCommand } from "../client/protocol.js";

import type { ApplicationReviewResponse } from "./review-channel.js";

type Unscoped<T> = T extends unknown ? Omit<T, "projectId"> : never;
export type ApplicationCommand = Unscoped<HarnessClientCommand>;

/** A client is bound by the host to one runtime. It never owns that runtime.
 * Reconnect explicitly and inspect durable state after an uncertain mutation;
 * connection-scoped idempotency keys are not permission to replay across clients.
 */
export async function connectApplication(credentialsPath: string) {
  const credentials = await readHarnessLocalCredentials(credentialsPath);
  const hello = await requestHarnessLocalService(credentials, "hello", { versions: [1] });
  if (!hello.ok) throw new Error(hello.error.code);
  const clientId = randomUUID();
  return {
    projectId: hello.projectId,
    capabilities: hello.capabilities,
    review(sessionId: string, runId: string) {
      return requestLocalServiceDocument(credentials, "review", { clientId, request: {
        protocolVersion: 1, requestId: `review_${randomUUID()}`, connectionId: hello.connectionId,
        command: { method: "run.get", projectId: hello.projectId, sessionId, runId, includeReview: true },
      } }) as Promise<ApplicationReviewResponse>;
    },
    decide(ticketId: string, approve: boolean) {
      return requestLocalServiceDocument(credentials, "decision", {
        protocolVersion: 1, requestId: `decision_${randomUUID()}`, connectionId: hello.connectionId,
        projectId: hello.projectId, clientId, ticketId, approve,
      }) as Promise<HarnessClientResponse>;
    },
    async command(command: ApplicationCommand | Record<string, unknown>) {
      if (!command || typeof command !== "object" || Array.isArray(command) || "projectId" in command) {
        throw new Error("APPLICATION_SCOPE_OVERRIDE");
      }
      const envelope = harnessClientRequestSchema.parse({
        protocolVersion: 1, requestId: `application_${randomUUID()}`,
        connectionId: hello.connectionId, command: { ...command, projectId: hello.projectId },
      });
      // Ordering and conflicts are authoritative in the host, not in a client queue.
      return requestHarnessLocalService(credentials, "command", envelope);
    },
    events(sessionId: string, after = 0) {
      return requestHarnessLocalService(credentials, "events", { projectId: hello.projectId, sessionId, after });
    },
  };
}

export type ApplicationClient = Awaited<ReturnType<typeof connectApplication>>;
