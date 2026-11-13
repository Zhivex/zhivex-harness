#!/usr/bin/env node
import { loadAssistantConfig } from './config.js';
import { assistantDoctor } from './doctor.js';
import { calendarCommand, calendarEnvironment } from "./calendar/cli.js";
import { startAssistantHost } from "./host.js";
import { googleCommand } from './integrations/google-cli.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => ['--setup', '--open', '--web', '--web-port'].includes(arg))) {
    console.error('The standalone web application has been retired. Open Zhivex Assistant (Tauri) for setup and the graphical interface.');
    process.exitCode = 1; return;
  }
  if (!args.length || args.includes("--help")) {
    console.log("Graphical interface and onboarding: open Zhivex Assistant (Tauri).");
    console.log("Coding (opt-in): --project /absolute/repository [--project /another/repository] --coding-execution local|oci. Local permits reviewed package scripts on this machine; OCI never falls back to local. The ready record provides each project's --service path for zhivex-code.");
    console.log("zhivex-assistant --directory /absolute/private/path --owner ID [--provider NAME] [--model NAME] [--recover] [--telegram-owner NUMERIC_ID] [--calendar] [--calendar-id ID] [--doctor] [--config /path/assistant.json]\nConfig v1: providers and Calendar, daily, google, github, web or MCP modules. Google OAuth with --config: --google-connect | --google-status | --google-disconnect.\nOAuth: --calendar-connect | --calendar-status | --calendar-disconnect (host stopped)\nTelegram token: ASSISTANT_TELEGRAM_BOT_TOKEN. Pairing challenge is printed locally.\nOffline preflight: add --doctor with the intended host flags (no network or state mutation).\nAfter linking: /daily HH:mm Zone/IANA, /daily status, /memory list.\nLocal foreground service; SIGINT/SIGTERM drains accepted work and preserves pending approvals.");
    return;
  }
  const values: Record<string, string> = {};
  const projects: string[] = [];
  let recover = false, calendar = false, doctor = false;
  let calendarAction: 'connect' | 'disconnect' | 'status' | undefined;
  let googleAction: 'connect' | 'disconnect' | 'status' | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--project') {
      const selected = args[++index];
      if (!selected || selected.startsWith('--') || projects.length >= 8) throw new Error('ASSISTANT_USAGE_INVALID');
      projects.push(selected); continue;
    }
    if (['--google-connect','--google-disconnect','--google-status'].includes(key) && !googleAction) {
      googleAction = key.slice('--google-'.length) as 'connect' | 'disconnect' | 'status'; continue;
    }
    if (key === '--doctor' && !doctor) { doctor = true; continue; }
    if (key === '--calendar' && !calendar) { calendar = true; continue; }
    if (['--calendar-connect','--calendar-disconnect','--calendar-status'].includes(key) && !calendarAction) {
      calendarAction = key.slice('--calendar-'.length) as 'connect' | 'disconnect' | 'status'; continue;
    }
    if (key === "--recover" && !recover) { recover = true; continue; }
    if (!["--directory", "--owner", "--provider", "--model", "--telegram-owner", "--calendar-id", "--config", "--coding-execution"].includes(key) || values[key] !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("ASSISTANT_USAGE_INVALID");
    values[key] = args[++index]!;
  }
  if (!values["--directory"] || !values["--owner"]) throw new Error("ASSISTANT_USAGE_INVALID");
  if (projects.length && !['local', 'oci'].includes(values['--coding-execution'] ?? '')) throw new Error('CODING_EXECUTION_REQUIRED');
  if (values['--coding-execution'] && (!projects.length || !['local', 'oci'].includes(values['--coding-execution']))) throw new Error('ASSISTANT_USAGE_INVALID');
  if (projects.length && (doctor || calendarAction || googleAction)) throw new Error('ASSISTANT_USAGE_INVALID');
  if (values['--calendar-id'] && !calendar) throw new Error('ASSISTANT_USAGE_INVALID');
  const config = values['--config'] ? await loadAssistantConfig(values['--config']) : undefined;
  if (googleAction) {
    if (!config?.google || calendarAction || calendar || doctor) throw new Error('ASSISTANT_USAGE_INVALID');
    await googleCommand(googleAction, values['--directory'], values['--owner'], config.google, recover); return;
  }
  if (config && (calendarAction || calendar || values['--calendar-id'])) throw new Error('ASSISTANT_USAGE_INVALID');
  if ((config?.compatibleProvider || config?.assistantProvider) && (values['--provider'] || values['--model'])) throw new Error('ASSISTANT_PROVIDER_CONFLICT');
  if (doctor) {
    if (calendarAction || recover) throw new Error('ASSISTANT_USAGE_INVALID');
    const result = await assistantDoctor({ directory: values['--directory'], ownerId: values['--owner'], calendar: calendar || Boolean(config?.hasCalendar),
      ...(config?.assistantProvider ? { assistantProvider: config.assistantProvider } : {}),
      ...(config?.compatibleProvider ? { compatibleProvider: config.compatibleProvider } : {}),
      ...(values['--telegram-owner'] ? { telegramOwner: values['--telegram-owner'] } : {}), ...(values['--provider'] ? { provider: values['--provider'] } : {}) });
    console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; return;
  }
  if (calendarAction) { if (calendar) throw new Error('ASSISTANT_USAGE_INVALID'); await calendarCommand(calendarAction, values['--directory'], values['--owner'], recover); return; }
  const host = await startAssistantHost({ directory: values["--directory"], ownerId: values["--owner"], recover,
    ...(projects.length ? { coding: { execution: values['--coding-execution'] as 'local' | 'oci', configurationId: 'assistant-cli-v1' } } : {}),
    ...(config ? { modules: config.modules, ...(config.taskMetricsPricing ? { taskMetricsPricing: config.taskMetricsPricing } : {}), ...(config.assistantProvider ? { assistantProvider: config.assistantProvider } : {}), ...(config.compatibleProvider ? { compatibleProvider: config.compatibleProvider } : {}) } : {}),
    ...(calendar ? { calendar: calendarEnvironment(values["--calendar-id"]) } : {}),
    ...(values["--telegram-owner"] ? { telegram: { token: process.env.ASSISTANT_TELEGRAM_BOT_TOKEN ?? "", expectedUserId: values["--telegram-owner"] } } : {}),
    engine: { ...(values["--provider"] ? { provider: values["--provider"] } : {}), ...(values["--model"] ? { model: values["--model"] } : {}) } });
  try {
    for (const selected of projects) {
      const result = await host.application!.client.registerProject(await host.application!.selectProject(selected));
      if (!result.ok) throw new Error(result.error.code);
      const connection = await host.application!.projectConnection(result.data.projectKey);
      console.log(JSON.stringify({ kind: 'assistant-project-ready', project: result.data, ...connection }));
    }
  } catch (error) { await host.close(); throw error; }
  console.log(JSON.stringify({ kind: "assistant-ready", credentialsPath: host.credentialsPath, ...host.diagnostics() }));
  if (host.pairingCode) console.log(JSON.stringify({ kind: "telegram-pairing", instruction: `/start ${host.pairingCode}`, expiresInSeconds: 600 }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void host.close().then(() => { console.log('{"kind":"assistant-stopped"}'); }, () => {
      console.error('{"kind":"assistant-error","code":"SHUTDOWN_FAILED"}'); process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
void main().catch(error => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,90}$/.test(error.message) ? error.message : 'START_FAILED';
  console.error(JSON.stringify({ kind: 'assistant-error', code })); process.exitCode = 1;
});
