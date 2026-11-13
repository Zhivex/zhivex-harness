import { syncPrivateDirectory } from './private-directory.js';
import { openAssistantApplication, type AssistantCodingOptions } from './application.js';
import { openTaskMetrics, taskUsageSchema, type TaskMetrics, type TaskRunSnapshot } from './task-metrics.js';
import { createAssistantProvider, type AssistantProviderConfig } from './providers/provider.js';
import { startAssistantWeb, type AssistantWebOptions } from './web/server.js';
import type { AgendaSource } from './automation/summary.js';
import { type CalendarConnectionOptions } from "./calendar/connection.js";
import { createCalendarModule } from "./modules/calendar.js";
import { openAssistantModules, type AssistantModule } from "./modules/module.js";
import { type CompatibleProviderConfig } from "./providers/openai-compatible.js";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import { createProfiledHarness, GENERAL_ASSISTANT_PROFILE, harnessAgentProfileSchema, type CreateProfiledHarnessOptions } from "@zhivex-ai/harness/engine";
import { startHarnessLocalService, recoverHarnessLocalService } from "@zhivex-ai/harness/service";
import { createTelegramBridge } from "./telegram/bridge.js";
import { createTelegramApi, type TelegramApi } from "./telegram/api.js";

export interface AssistantHostOptions {
  directory: string;
  /** Opt-in coding registry; never populated from Telegram or web messages. */
  coding?: AssistantCodingOptions;
  /** Explicit dated token prices; missing/stale prices remain unknown. */
  taskMetricsPricing?: NonNullable<CreateProfiledHarnessOptions["usageAccounting"]>["pricing"];
  web?: AssistantWebOptions;
  ownerId: string;
  /** Explicit dead-process recovery. Never steals a live service. */
  recover?: boolean;
  calendar?: CalendarConnectionOptions;
  modules?: readonly AssistantModule[];
  compatibleProvider?: CompatibleProviderConfig;
  assistantProvider?: AssistantProviderConfig;
  telegram?: { token: string; expectedUserId: string; confirmedPrivateChatId?: string; confirmedUpdateOffset?: number; api?: TelegramApi };
  /** Trusted application configuration only; never deserialize this from channel messages. */
  engine?: Partial<Pick<CreateProfiledHarnessOptions, "provider" | "model" | "modelInstance" | "agentProfile" |
    "mcpConfiguration" | "mcpClients" | "toolPolicy" | "timeoutMs" | "maxSteps" | "maxToolCalls">>;
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("ASSISTANT_DIRECTORY_UNSAFE");
  }
  return realpath(directory);
}

/** Long-lived local host. Harness exclusively owns conversation/run/approval persistence. */
export async function startAssistantHost(options: AssistantHostOptions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.ownerId)) throw new Error('ASSISTANT_OWNER_INVALID');
  if (options.compatibleProvider && options.assistantProvider) throw new Error('ASSISTANT_PROVIDER_CONFLICT');
  const providerConfig = options.assistantProvider ?? options.compatibleProvider;
  if (providerConfig && (options.engine?.modelInstance || options.engine?.provider || options.engine?.model)) throw new Error('ASSISTANT_PROVIDER_CONFLICT');
  const provider = providerConfig ? createAssistantProvider(providerConfig) : undefined;
  const definitions = [...(options.modules ?? []), ...(options.calendar ? [createCalendarModule(options.calendar)] : [])];
  if (definitions.length && (options.engine?.agentProfile || options.engine?.mcpClients || options.engine?.mcpConfiguration)) throw new Error('ASSISTANT_MODULE_ENGINE_CONFLICT');
  const directory = await privateDirectory(path.resolve(options.directory));
  const modules = definitions.length ? await openAssistantModules(definitions, { directory, ownerId: options.ownerId, recover: options.recover ?? false }) : undefined;
  try {
    let engine = { ...options.engine, ...modules?.engine };
    if (provider) {
      const base = engine.agentProfile ?? GENERAL_ASSISTANT_PROFILE;
      engine = { ...engine, provider: provider.provider, model: provider.config.model, modelInstance: provider.model,
        agentProfile: { ...base, toolNames: [...base.toolNames], instructions: base.instructions + `\nAssistant provider configuration digest: ${provider.binding}` } };
    }
    const coding = options.coding && provider ? { ...options.coding, configurationId: createHash("sha256").update(JSON.stringify([options.coding.configurationId, provider.binding])).digest("hex") } : options.coding;
    return await startAssistantHostOwned({ ...options, ...(coding ? { coding } : {}), engine }, modules?.close, modules?.approvalDetails, modules?.agendaSource, modules?.reviewTools,
      modules?.identity.map(item => ({ id: item.id, version: item.version })), modules);
  } catch (error) { await modules?.close().catch(() => {}); throw error; }
}

async function startAssistantHostOwned(options: AssistantHostOptions, closeModules?: () => Promise<void>, approvalDetails?: (run: import('@zhivex-ai/harness/protocol').HarnessClientRun) => Promise<unknown>, agendaSource?: AgendaSource, reviewTools?: string[], moduleIdentity?: { id: string; version: string }[], modules?: Awaited<ReturnType<typeof openAssistantModules>>) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.ownerId)) throw new Error("ASSISTANT_OWNER_INVALID");
  const profile = harnessAgentProfileSchema.parse(options.engine?.agentProfile ?? GENERAL_ASSISTANT_PROFILE);
  const directory = await privateDirectory(path.resolve(options.directory));
  const workspace = await privateDirectory(path.join(directory, "workspace"));
  const transport = await privateDirectory(path.join(directory, "transport"));
  const state = await privateDirectory(path.join(directory, "state"));
  const binding = JSON.stringify({ schemaVersion: 1, ownerId: options.ownerId,
    profileDigest: createHash("sha256").update(JSON.stringify({ ...profile, toolNames: [...new Set(profile.toolNames)].sort() })).digest("hex") });
  // Exclusive creation prevents racing owners. Incomplete/corrupt state fails closed.
  const manifestPath = path.join(state, "host.json");
  let created = false;
  const file = await open(manifestPath, "wx", 0o600).then(handle => {
    created = true;
    return handle;
  }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  });
  try {
    if (created) {
      await file.writeFile(binding);
      await file.sync();
      await syncPrivateDirectory(state, "ASSISTANT_DIRECTORY_UNSAFE");
    }
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) throw new Error("ASSISTANT_STATE_UNSAFE");
    if (!created && await file.readFile("utf8") !== binding) throw new Error("ASSISTANT_HOST_BINDING_MISMATCH");
  } finally { await file.close(); }
  const harness = await createProfiledHarness({
    ...options.engine, usageAccounting: { ...(options.taskMetricsPricing ? { pricing: options.taskMetricsPricing } : {}) }, agentProfile: profile, workspace, stateDirectory: path.join(workspace, ".zhivex-harness"),
    tenantId: "assistant-local", userId: options.ownerId, namespace: "assistant-v1", storeBackend: "sqlite",
    executionBackend: "none", subagentProfiles: [], projectContext: false, projectMemory: false,
    timeoutMs: options.engine?.timeoutMs ?? 60_000, maxSteps: options.engine?.maxSteps ?? 16,
    maxToolCalls: options.engine?.maxToolCalls ?? 16
  });
  let serviceOwnsHarness = false;
  let metrics: TaskMetrics | undefined;
  const observeRun = async (sessionId: string, runId: string) => {
    const run = await harness.store.load(runId, harness.config.scope);
    // Use the public durable usage ledger, never sum streaming/cumulative receipts.
    let usage: TaskRunSnapshot['usage'] = null;
    try { usage = taskUsageSchema.parse(harness.usageLedger?.summary(runId)); } catch { /* A pre-initialization failure has no usage receipt. */ }
    if (!run || run.startedAt === undefined || run.updatedAt === undefined) return; // Preserve an uncertain observation rather than invent a finish time.
    metrics?.observe({ runId, sessionId, status: run.status,
      startedAt: run.startedAt, updatedAt: run.updatedAt, usage });
  };
  const refreshMetrics = async () => {
    for (const ref of metrics?.references() ?? []) await observeRun(ref.sessionId, ref.runId);
  };
  try {
    if (options.recover) await recoverHarnessLocalService(harness, transport);
    const service = await startHarnessLocalService(harness, { directory: transport,
      onPrompt: (sessionId, runId) => { const timestamp = Date.now(); metrics!.observe({ runId, sessionId,
        status: 'running', startedAt: timestamp, updatedAt: timestamp, usage: null }); },
      onCheckpoint: (sessionId, runId) => observeRun(sessionId, runId)
    });
    serviceOwnsHarness = true;
    service.pauseAdmission();
    let telegram: Awaited<ReturnType<typeof createTelegramBridge>> | undefined;
    try {
      metrics = await openTaskMetrics(state);
      await refreshMetrics();
      service.resumeAdmission();
      if (options.telegram) {
        telegram = await createTelegramBridge({ stateDirectory: state, credentialsPath: service.credentialsPath,
          ownerId: options.ownerId, expectedTelegramUserId: options.telegram.expectedUserId,
          ...(options.telegram.confirmedPrivateChatId ? { confirmedPrivateChatId: options.telegram.confirmedPrivateChatId, ...(options.telegram.confirmedUpdateOffset !== undefined ? { confirmedUpdateOffset: options.telegram.confirmedUpdateOffset } : {}) } : {}),
          ...(approvalDetails ? { approvalDetails } : {}), ...(reviewTools ? { reviewTools } : {}), ...(agendaSource ? { agendaSource } : {}), ...(modules?.summarySources.length ? { summarySources: modules.summarySources } : {}), api: options.telegram.api ?? createTelegramApi(options.telegram.token), recover: options.recover ?? false });
        telegram.start();
      }
    } catch (error) { try { await service.close(); } finally { metrics?.close(); } throw error; }
    let closePromise: Promise<void> | undefined;
    let web: Awaited<ReturnType<typeof startAssistantWeb>> | undefined;
    let application: Awaited<ReturnType<typeof openAssistantApplication>> | undefined;
    modules?.start({ ...(telegram ? { notifications: telegram.notifications } : {}) });
    const host = {
      get application() { return application; },
      async controlClose(operation: 'pause' | 'resume' | 'cancel') {
        const projectBusy = await application?.controlClose(operation) ?? false;
        if (operation === 'resume') { service.resumeAdmission(); return false; }
        if (operation === 'cancel') await service.cancelActive();
        return service.pauseAdmission() || projectBusy;
      },
      daily: modules?.daily,
      taskMetrics: {
        async report() { await refreshMetrics(); return metrics!.report(); },
        async feedback(input: unknown) { await refreshMetrics(); return metrics!.feedback(input); },
        async link(input: unknown) { await refreshMetrics(); return metrics!.link(input); }
      },
      async runPrompt(runId: string) {
        const run = await harness.store.load(runId, harness.config.scope);
        const message = run?.messages.slice().reverse().find(message => message.role === 'user');
        if (!message) return undefined;
        return message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      },
      credentialsPath: service.credentialsPath,
      pairingCode: telegram?.pairingCode,
      approvalDetails, agendaSource, reviewTools, automation: telegram?.automation,
      diagnostics: () => ({ schemaVersion: 1, product: "assistant", ownerId: options.ownerId,
        profile: { id: profile.id, version: profile.version }, transport: "unix", persistence: "sqlite",
        ...(telegram ? { telegram: telegram.diagnostics() } : {}),
        modules: moduleIdentity ?? [],
        ...(options.engine?.model ? { provider: { kind: options.engine.provider ?? 'configured', model: options.engine.model, apiMode: options.compatibleProvider?.apiMode ?? 'configured' } } : {}),
        ...(options.calendar ? { calendar: { enabled: true, calendarId: options.calendar.calendarId ?? 'primary' } } : {}) }),
      // In-process trusted UI only; remote callbacks must use the ordinary protocol.
      dispatchReviewed: service.dispatchReviewed.bind(service),
      close: () => closePromise ??= (async () => { try { await application?.close(); } finally { try { await web?.close(); } finally { try { await modules?.daily?.stop(); } finally { try { await telegram?.close(); } finally { try { await service.close(); } finally { try { metrics?.close(); } finally { await closeModules?.(); } } } } } } })()
    };
    try {
      if (options.coding) application = await openAssistantApplication({ directory, ownerId: options.ownerId, generalCredentialsPath: service.credentialsPath, recover: options.recover ?? false,
        coding: { ...options.coding, engine: {
          ...(options.engine?.provider ? { provider: options.engine.provider } : {}),
          ...(options.engine?.model ? { model: options.engine.model } : {}),
          ...(options.engine?.modelInstance ? { modelInstance: options.engine.modelInstance } : {}),
          ...options.coding.engine,
        } } });
      if (options.web) web = await startAssistantWeb(host, options.web);
    }
    catch (error) { await host.close(); throw error; }
    return { ...host, application, webUrl: web?.url };
  } catch (error) { if (!serviceOwnsHarness) await harness.close(); throw error; }
}
