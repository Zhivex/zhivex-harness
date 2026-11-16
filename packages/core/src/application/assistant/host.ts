import {applicationRuntimeBinding} from '../runtime-binding.js';
import {attachCalendarChange, attachCalendarCreation} from '../calendar-review.js';
import { projectApprovalReview } from '../approval-review.js';
import { startApplicationHost } from "../host.js";
import { syncPrivateDirectory } from './private-directory.js';
import { openTaskMetrics, taskUsageSchema, type TaskMetrics, type TaskRunSnapshot } from './task-metrics.js';
import { createAssistantProvider, type AssistantProviderConfig } from './providers/provider.js';
import type { AgendaSource } from './automation/summary.js';
import { type CalendarConnectionOptions } from "./calendar/connection.js";
import { createCalendarModule } from "./modules/calendar.js";
import { openAssistantModules, type AssistantModule } from "./modules/module.js";
import { type CompatibleProviderConfig } from "./providers/openai-compatible.js";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createProfiledHarness, GENERAL_ASSISTANT_PROFILE, harnessAgentProfileSchema, type CreateProfiledHarnessOptions } from "../../engine/index.js";
import { recoverHarnessLocalService } from "../../engine/service.js";
import { createTelegramBridge } from "./telegram/bridge.js";
import { createTelegramApi, type TelegramApi } from "./telegram/api.js";

export interface AssistantHostOptions {
  directory: string;
  /** Host-only values to remove from transport projections. */
  sensitiveValues?: readonly string[];
  /** Explicit dated token prices; missing/stale prices remain unknown. */
  taskMetricsPricing?: NonNullable<CreateProfiledHarnessOptions["usageAccounting"]>["pricing"];
  ownerId: string;
  /** Explicit dead-process recovery. Never steals a live service. */
  recover?: boolean;
  /** Trusted coordinator-only transition after pausing and inspecting all runs. Exact prior manifest required. */
  rebindFrom?: string;
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
    return await startAssistantHostOwned({ ...options, engine }, modules?.close, modules?.approvalDetails, modules?.agendaSource, modules?.reviewTools,
      modules?.identity.map(item => ({ id: item.id, version: item.version })), modules);
  } catch (error) { await modules?.close().catch(() => {}); throw error; }
}

async function startAssistantHostOwned(options: AssistantHostOptions, closeModules?: () => Promise<void>, approvalDetails?: (run: import('../../engine/protocol.js').HarnessClientRun) => Promise<unknown>, agendaSource?: AgendaSource, reviewTools?: string[], moduleIdentity?: { id: string; version: string }[], modules?: Awaited<ReturnType<typeof openAssistantModules>>) {
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
    if (!created) {
      const previous = await file.readFile("utf8");
      if (previous !== binding) {
        if (options.rebindFrom !== previous || JSON.parse(previous).ownerId !== options.ownerId) throw new Error("ASSISTANT_HOST_BINDING_MISMATCH");
        // An explicit transition never replaces a live service's manifest.
        for (const name of await readdir(transport)) {
          if (!name.endsWith('.lock')) continue;
          const lease = JSON.parse(await readFile(path.join(transport, name), 'utf8'));
          if (!Number.isInteger(lease.pid) || lease.pid <= 0) throw new Error('ASSISTANT_REBIND_LEASE_INVALID');
          try {process.kill(lease.pid, 0); throw new Error('ASSISTANT_REBIND_OWNER_ALIVE');}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
        }
        const temporary = manifestPath + '.next';
        try {const replacement = await open(temporary, 'wx', 0o600); try {await replacement.writeFile(binding); await replacement.sync();} finally {await replacement.close();} await rename(temporary, manifestPath); await syncPrivateDirectory(state, "ASSISTANT_DIRECTORY_UNSAFE");}
        finally {await unlink(temporary).catch(() => {});}
      }
    }
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
    const service = await startApplicationHost(harness, { directory: transport,
      sensitiveValues: options.sensitiveValues ?? [],
      onPrompt: (sessionId, runId) => { const timestamp = Date.now(); metrics!.observe({ runId, sessionId,
        status: 'running', startedAt: timestamp, updatedAt: timestamp, usage: null }); },
      onCheckpoint: (sessionId, runId) => observeRun(sessionId, runId)
    }, { tools: profile.toolNames, project: async (run, redact, redactContactDetails) => {
      const projection = projectApprovalReview(run, redact);
      const details = approvalDetails ? await approvalDetails(run) : [];
      for (const item of projection.items) {
        if (item.payload.includes('[REDACTED]')) {item.complete = false; item.restriction = 'REDACTED';}

        if (!reviewTools?.includes(item.name)) continue;
        const detail = Array.isArray(details) ? details.find(value => value?.approvalId === item.approvalId) : undefined;
        if (!detail) { item.complete = false; item.restriction = 'BASE_UNAVAILABLE'; continue; }
        const raw = JSON.stringify(detail, null, 2), safe = ['daily_write_apply_reply_watch', 'calendar_write_apply', 'calendar_write_create', 'google_write_mail_apply_draft', 'microsoft_write_apply'].includes(item.name) ? redactContactDetails(raw) : redact(raw);
        if (Buffer.byteLength(raw) > 100_000 || raw !== safe) { item.complete = false; item.restriction = raw !== safe ? 'REDACTED' : 'TOO_LARGE'; continue; }
        if (item.name === 'calendar_write_apply') attachCalendarChange(item, detail);
        if (item.name === 'calendar_write_create') attachCalendarCreation(item, detail);
        item.payload += '\n\nResolved action details:\n' + safe;
      }
      return projection;
    } });
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
    modules?.start({ ...(telegram ? { notifications: telegram.notifications } : {}) });
    const host = {
      binding: () => applicationRuntimeBinding(harness),
      daily: modules?.daily,
      taskMetrics: {
        async report() { await refreshMetrics(); return metrics!.report(); },
        async feedback(input: unknown) { await refreshMetrics(); return metrics!.feedback(input); },
        async link(input: unknown) { await refreshMetrics(); return metrics!.link(input); }
      },
      credentialsPath: service.credentialsPath,
      pairingCode: telegram?.pairingCode,
      prepareCalendarCreation: modules?.prepareCalendarCreation,
      mailDrafts: modules?.mailDrafts,
      approvalDetails, agendaSource, reviewTools, automation: telegram?.automation,
      diagnostics: () => ({ schemaVersion: 1, product: "assistant", ownerId: options.ownerId,
        profile: { id: profile.id, version: profile.version }, transport: "unix", persistence: "sqlite",
        ...(telegram ? { telegram: telegram.diagnostics() } : {}),
        modules: moduleIdentity ?? [],
        ...(options.engine?.model ? { provider: { kind: options.engine.provider ?? 'configured', model: options.engine.model, apiMode: options.compatibleProvider?.apiMode ?? 'configured' } } : {}),
        ...(options.calendar ? { calendar: { enabled: true, calendarId: options.calendar.calendarId ?? 'primary' } } : {}) }),
      // In-process trusted UI only; remote callbacks must use the ordinary protocol.
      dispatchReviewed: service.dispatchReviewed.bind(service),
      pauseAdmission: service.pauseAdmission.bind(service),
      resumeAdmission: service.resumeAdmission.bind(service),
      cancelActive: service.cancelActive.bind(service),
      close: () => closePromise ??= (async () => { try { await modules?.daily?.stop(); } finally { try { await telegram?.close(); } finally { try { await service.close(); } finally { try { metrics?.close(); } finally { await closeModules?.(); } } } } })()
    };
    return host;
  } catch (error) { if (!serviceOwnsHarness) await harness.close(); throw error; }
}
