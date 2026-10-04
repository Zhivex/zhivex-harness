import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ZhivexHarness } from "@zhivex-ai/harness/engine";
import { harnessClientRequestSchema } from "@zhivex-ai/harness/protocol";
import {
  startHarnessLocalService,
  readHarnessLocalCredentials,
  requestHarnessLocalService,
  recoverHarnessLocalService,
} from "@zhivex-ai/harness/service";
import {
  desktopRedactor,
  hostSensitiveValues,
} from "../../../desktop/src/redaction.js";
import { projectApprovalReview } from "../../../desktop/src/approval-review.js";
import { ReviewTickets } from "../../../desktop/src/review-tickets.js";
import type { WebModelChoice, WebModelSelection } from "./contracts.js";

/** Server-owned workspace, identity, policy and provider. No browser configuration enters Harness. */
export async function attachRuntime(
  harness: ZhivexHarness,
  directory: string,
  recover: boolean,
  secrets: readonly string[] = [],
) {
  if (recover)
    try {
      await recoverHarnessLocalService(harness, directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  const service = await startHarnessLocalService(harness, {
    directory,
    sensitiveValues: secrets,
  });
  try {
    const credentials = await readHarnessLocalCredentials(
      service.credentialsPath,
    );
    const hello = await requestHarnessLocalService(credentials, "hello", {
      versions: [1],
    });
    if (!hello.ok) throw new Error("WEB_PROTOCOL_UNSUPPORTED");
    const redactor = desktopRedactor([
      ...hostSensitiveValues(process.env),
      ...secrets,
      credentials.token,
    ]);
    // Each HTTP browser session has its own review tickets; tickets never cross identities.
    const tickets = new Map<string, ReviewTickets>();
    const envelope = (command: Record<string, unknown>) =>
      harnessClientRequestSchema.parse({
        protocolVersion: 1,
        requestId: `web_${randomUUID()}`,
        connectionId: hello.connectionId,
        command: { ...command, projectId: hello.projectId },
      });
    const command = async (value: Record<string, unknown>) =>
      requestHarnessLocalService(credentials, "command", envelope(value));
    return {
      workspace: {
        key: hello.projectId,
        name: redactor.text(path.basename(harness.config.workspace)),
        workspace: redactor.text(harness.config.workspace),
        provider: harness.config.provider,
        model: redactor.text(harness.config.model),
      },
      async command(value: Record<string, unknown>) {
        return redactor.response(await command(value));
      },
      async events(sessionId: string, after: number) {
        return redactor.redact(
          await requestHarnessLocalService(credentials, "events", {
            projectId: hello.projectId,
            sessionId,
            after,
          }),
        );
      },
      async review(identity: string, sessionId: string, runId: string) {
        const response = await command({
          method: "run.get",
          sessionId,
          runId,
          includeReview: true,
        });
        if (!response.ok || response.data.kind !== "run")
          throw new Error("WEB_REVIEW_UNAVAILABLE");
        let store = tickets.get(identity);
        if (!store) {
          store = new ReviewTickets();
          tickets.set(identity, store);
        }
        return store.issue(
          sessionId,
          projectApprovalReview(response.data.run, redactor.text),
        );
      },
      async decide(identity: string, ticketId: string, approve: boolean) {
        const decision = tickets.get(identity)?.consume(ticketId, approve);
        if (!decision) throw new Error("REVIEW_REQUIRED");
        // The existing trusted host path enforces revision, expiry, full digest set and signed engine approval.
        return redactor.response(
          await service.dispatchReviewed(envelope(decision)),
        );
      },
      forgetIdentity(identity: string) {
        tickets.delete(identity);
      },
      async close() {
        service.pauseAdmission();
        await service.cancelActive();
        await service.close();
      },
    };
  } catch (e) {
    await service.close();
    throw e;
  }
}
export type WebRuntime = Awaited<ReturnType<typeof attachRuntime>> & {
  modelChoices?(): Promise<WebModelChoice[]>;
  selectModel?(selection: WebModelSelection): Promise<void>;
};
