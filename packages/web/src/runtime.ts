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
import {
  appendAutoApproval,
  approvalFacts,
  buildSnapshots,
  createAutoApprovalEntry,
  decideBatch,
  loadApprovalConfig,
  publicAutoApproval,
  readAutoApprovals,
  readWorkspaceSnapshot,
  resolveAutoApprovePolicy,
  revertAutoApproval,
  writeApprovalConfig,
  type ApprovalConfigFile,
  type AutoApproveMode,
} from "../../../src/approvals/auto-approve.js";
import type { WebModelChoice, WebModelSelection } from "./contracts.js";
import { bundledModelCatalog, catalogModels } from "@zhivex-ai/harness/code-support";
import { WebLimitStore } from "./limit-store.js";
import { WebLimitMonitor } from "./limit-monitor.js";
import type { LimitScope, LimitSettings } from "./limit-settings.js";
import { validateStateDirectory } from "@zhivex-ai/harness/desktop/v1/state";
import { hostConfigDigest } from "./host-config-digest.js";
import { WEB_DEFAULT_STOP } from "./default-budgets.js";

/** Server-owned workspace, identity, policy and provider. No browser configuration enters Harness. */
export async function attachRuntime(
  harness: ZhivexHarness,
  directory: string,
  recover: boolean,
  secrets: readonly string[] = [],
  legacyPending = false,
  toolPolicyLabel?: string,
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
  const limitMonitor = new WebLimitMonitor(limitStore, () => cancelLimits(), price, Date.now, hostConfigDigest(harness.config), WEB_DEFAULT_STOP);
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
  let approvalFile: ApprovalConfigFile = { mode: "manual", commandAllowlist: [] };
  try { approvalFile = await loadApprovalConfig(harness.config.workspace); } catch { /* A bad file stays manual. */ }
  const sessionModes = new Map<string, AutoApproveMode>();
  const approvalPolicy = (sessionId: string, overLimit: boolean) => resolveAutoApprovePolicy({
    rootDir: harness.config.workspace,
    file: approvalFile,
    ...(sessionModes.get(sessionId) ? { sessionMode: sessionModes.get(sessionId)! } : {}),
    ...(overLimit ? { overLimit: true } : {}),
  });
  const overLimit = (runId: string) => {
    const run = limitMonitor.snapshot(runId);
    if (!run) return false;
    if (run.notices.some(notice => notice.action === "stop")) return true;
    return (Object.keys(run.settings) as (keyof typeof run.settings)[]).some(name => {
      const threshold = run.settings[name];
      const actual = run.consumption[name];
      return threshold.action === "stop" && threshold.value !== null && actual !== null && actual >= threshold.value;
    });
  };
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
        taskProtocol: { connectionId: hello.connectionId, projectId: hello.projectId, capabilities: hello.capabilities },
        name: redactor.text(path.basename(harness.config.workspace)),
        workspace: redactor.text(harness.config.workspace),
        provider: harness.config.provider,
        model: redactor.text(harness.config.model),
        ...(toolPolicyLabel ? { toolPolicy: toolPolicyLabel } : {}),
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
        const projected = projectApprovalReview(response.data.run, redactor.text);
        const raw = response.data.run.approvals.map(approval => {
          const action = approval.action as { name?: unknown; arguments?: unknown } | undefined;
          return {
            name: typeof action?.name === "string" ? action.name : "unknown",
            arguments: typeof action?.arguments === "string" ? action.arguments : "{}",
          };
        });
        const policy = approvalPolicy(sessionId, overLimit(runId));
        const batch = decideBatch(raw, policy);
        if (batch.auto && policy.mode !== "manual" && projected.items.length === raw.length && projected.items.every(item => item.complete)) {
          const records = [];
          for (const [index, item] of raw.entries()) {
            const facts = approvalFacts(item.name, item.arguments);
            const cache = new Map<string, { text: string | null; undoable: boolean }>();
            for (const file of facts.paths) cache.set(file.path, await readWorkspaceSnapshot(harness.config.workspace, file.path));
            const snapshots = buildSnapshots(item.arguments, relative => cache.get(relative) ?? { text: null, undoable: false });
            const approvalId = projected.items[index]?.approvalId ?? `approval-${index}`;
            records.push(createAutoApprovalEntry({
              approvalId,
              name: item.name,
              mode: policy.mode,
              reason: batch.results[index]?.decision === "auto" ? batch.results[index].reason : "edit-in-root",
              snapshots,
            }));
          }
          const resolved = await service.dispatchReviewed(envelope({
            method: "approval.resolve",
            sessionId,
            runId,
            expectedRevision: projected.revision,
            idempotencyKey: `auto_${randomUUID()}`,
            decisions: projected.items.map(item => ({ approvalId: item.approvalId, digest: item.digest, approve: true })),
          }));
          for (const record of records) await appendAutoApproval(harness.config.workspace, record);
          return { ...redactor.response(resolved), autoApproved: true as const, records: records.map(publicAutoApproval) };
        }
        let store = tickets.get(identity);
        if (!store) {
          store = new ReviewTickets();
          tickets.set(identity, store);
        }
        return store.issue(sessionId, projected);
      },
      async autoApprove(sessionId = "") {
        const policy = approvalPolicy(sessionId, false);
        const records = (await readAutoApprovals(harness.config.workspace)).slice(-20).map(entry => {
          const view = publicAutoApproval(entry);
          return { ...view, name: redactor.text(view.name), reason: redactor.text(view.reason), paths: view.paths.map(item => redactor.text(item)) };
        });
        return {
          mode: policy.mode,
          source: sessionModes.has(sessionId) ? "session" as const : approvalFile.mode === "manual" && approvalFile.commandAllowlist.length === 0 ? "default" as const : "workspace" as const,
          commandAllowlist: [...policy.commandAllowlist],
          records,
        };
      },
      async setAutoApprove(scope: "session" | "workspace", mode: AutoApproveMode, sessionId = "") {
        if (mode !== "manual" && mode !== "auto-edits" && mode !== "auto-limits") throw new Error("AUTO_APPROVE_CONFIG_INVALID");
        if (scope === "workspace") {
          approvalFile = { mode, commandAllowlist: approvalFile.commandAllowlist };
          await writeApprovalConfig(harness.config.workspace, approvalFile);
        } else sessionModes.set(sessionId, mode);
        return this.autoApprove(sessionId);
      },
      async undoAutoApproval(id: string) {
        if (!/^auto_[0-9a-f-]{36}$/i.test(id)) throw new Error("AUTO_APPROVE_UNDO_INVALID");
        const result = await revertAutoApproval(harness.config.workspace, id);
        if (!result.ok) throw new Error("AUTO_APPROVE_UNDO_REFUSED");
        return { ok: true as const, paths: result.paths.map(item => redactor.text(item)) };
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
