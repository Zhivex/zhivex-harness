import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
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
import { bundledModelCatalog, catalogModels } from "@zhivex-ai/harness/code-support";
import { WebLimitStore } from "./limit-store.js";
import { WebLimitMonitor } from "./limit-monitor.js";
import type { LimitScope, LimitSettings } from "./limit-settings.js";
import { validateStateDirectory } from "@zhivex-ai/harness/desktop/v1/state";
import { hostConfigDigest } from "./host-config-digest.js";

/** Server-owned workspace, identity, policy and provider. No browser configuration enters Harness. */
export async function attachRuntime(
  harness: ZhivexHarness,
  directory: string,
  recover: boolean,
  secrets: readonly string[] = [],
  legacyPending = false,
) {
  const limitDirectory = path.join(harness.config.stateDirectory, "web-limits");
  await validateStateDirectory(harness.config.workspace, limitDirectory);
  await mkdir(limitDirectory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const limitStore = new WebLimitStore(limitDirectory, [harness.config.workspace, harness.config.scope]);
  await limitStore.read();
  const catalogPrice = catalogModels(bundledModelCatalog, harness.config.provider).find(model => model.id === harness.config.model)?.pricing;
  const price = harness.config.costBudget ? {
    inputPerMillion: harness.config.costBudget.inputCostPer1kTokens * 1000,
    outputPerMillion: harness.config.costBudget.outputCostPer1kTokens * 1000,
    source: "Host configuration",
  } : catalogPrice ? { inputPerMillion: catalogPrice.inputPerMillionTokens, outputPerMillion: catalogPrice.outputPerMillionTokens,
    ...(catalogPrice.maxInputTokens === undefined ? {} : { maxInputTokens: catalogPrice.maxInputTokens }),
    source: `${catalogPrice.evidence.sourceUrl} (${catalogPrice.evidence.checkedAt})` } : null;
  let cancelLimits: () => Promise<void> = async () => {};
  const limitMonitor = new WebLimitMonitor(limitStore, () => cancelLimits(), price, Date.now, hostConfigDigest(harness.config));
  if (recover)
    try {
      await recoverHarnessLocalService(harness, directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  const service = await startHarnessLocalService(harness, {
    directory,
    sensitiveValues: secrets,
    onPrompt: (sessionId, runId) => limitMonitor.admitted(sessionId, runId),
    onEvent: (sessionId, runId, event) => limitMonitor.event(sessionId, runId, event).catch(() => limitMonitor.failed(runId)),
    onCheckpoint: (sessionId, runId, status) => limitMonitor.checkpoint(sessionId, runId, status).catch(() => limitMonitor.failed(runId)),
  });
  cancelLimits = () => service.cancelActive();
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
      async limits() {
        return { workspaceKey: hello.projectId, legacyPending, preferences: await limitStore.read(), pricing: price,
          host: { costUsd: harness.config.costBudget?.maxCostUsd ?? null, steps: harness.config.budget.unlimitedSteps ? null : harness.config.maxSteps, toolCalls: harness.config.budget.unlimitedToolCalls ? null : harness.config.budget.maxToolCalls,
            tokens: harness.config.budget.unlimitedTokens ? null : harness.config.budget.maxTotalTokens,
            durationMinutes: harness.config.unlimitedDuration ? null : harness.config.timeoutMs / 60_000 } };
      },
      async configureLimits(scope: LimitScope, settings: LimitSettings, expectedRevision: number) {
        if (settings.costUsd.value !== null && !price) throw new Error("WEB_LIMIT_PRICING_UNAVAILABLE");
        return limitStore.save(scope, settings, expectedRevision);
      },
      async runLimits(sessionId: string, runId: string) {
        // The normal protocol read binds this run to the selected session/scope.
        const receipt = await command({ method: "run.get", sessionId, runId });
        if (!receipt.ok) throw new Error("WEB_LIMIT_RUN_INVALID");
        const snapshot = limitMonitor.snapshot(runId) ?? await limitStore.readRun(runId);
        return snapshot?.sessionId === sessionId ? snapshot : null;
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
        await limitMonitor.close();
        await service.cancelActive();
        await service.close();
      },
    };
  } catch (e) {
    await limitMonitor.close();
    await service.close();
    throw e;
  }
}
export type WebRuntime = Awaited<ReturnType<typeof attachRuntime>> & {
  modelChoices?(): Promise<WebModelChoice[]>;
  selectModel?(selection: WebModelSelection): Promise<void>;
};
