#!/usr/bin/env node
import { loadAssistantConfig } from './config.js';
import { assistantDoctor } from './doctor.js';
import { calendarCommand, calendarEnvironment } from "./calendar/cli.js";
import { startAssistantHost } from "./host.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("zhivex-assistant --directory /absolute/private/path --owner ID [--provider NAME] [--model NAME] [--recover] [--telegram-owner NUMERIC_ID] [--calendar] [--calendar-id ID] [--web] [--web-port PORT] [--doctor] [--config /path/assistant.json]\nConfig v1: OpenAI-compatible provider and explicit Calendar/MCP modules.\nOAuth: --calendar-connect | --calendar-status | --calendar-disconnect (host stopped)\nTelegram token: ASSISTANT_TELEGRAM_BOT_TOKEN. Pairing challenge is printed locally.\nOffline preflight: add --doctor with the intended host flags (no network or state mutation).\nAfter linking: /daily HH:mm Zone/IANA, /daily status, /memory list.\nLocal foreground service; SIGINT/SIGTERM drains accepted work and preserves pending approvals.");
    return;
  }
  const values: Record<string, string> = {};
  let recover = false, calendar = false, doctor = false, web = false;
  let calendarAction: 'connect' | 'disconnect' | 'status' | undefined;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--web' && !web) { web = true; continue; }
    if (key === '--doctor' && !doctor) { doctor = true; continue; }
    if (key === '--calendar' && !calendar) { calendar = true; continue; }
    if (['--calendar-connect','--calendar-disconnect','--calendar-status'].includes(key) && !calendarAction) {
      calendarAction = key.slice('--calendar-'.length) as 'connect' | 'disconnect' | 'status'; continue;
    }
    if (key === "--recover" && !recover) { recover = true; continue; }
    if (!["--directory", "--owner", "--provider", "--model", "--telegram-owner", "--calendar-id", "--config", "--web-port"].includes(key) || values[key] !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("ASSISTANT_USAGE_INVALID");
    values[key] = args[++index]!;
  }
  if (!values["--directory"] || !values["--owner"]) throw new Error("ASSISTANT_USAGE_INVALID");
  if (values['--calendar-id'] && !calendar) throw new Error('ASSISTANT_USAGE_INVALID');
  if (values['--web-port'] && (!web || !/^\d{1,5}$/.test(values['--web-port']) || Number(values['--web-port']) > 65535)) throw new Error('ASSISTANT_USAGE_INVALID');
  const config = values['--config'] ? await loadAssistantConfig(values['--config']) : undefined;
  if (config && (calendarAction || calendar || values['--calendar-id'])) throw new Error('ASSISTANT_USAGE_INVALID');
  if (config?.compatibleProvider && (values['--provider'] || values['--model'])) throw new Error('ASSISTANT_PROVIDER_CONFLICT');
  if (doctor) {
    if (calendarAction || recover) throw new Error('ASSISTANT_USAGE_INVALID');
    const result = await assistantDoctor({ directory: values['--directory'], ownerId: values['--owner'], calendar: calendar || Boolean(config?.hasCalendar),
      ...(config?.compatibleProvider ? { compatibleProvider: config.compatibleProvider } : {}),
      ...(values['--telegram-owner'] ? { telegramOwner: values['--telegram-owner'] } : {}), ...(values['--provider'] ? { provider: values['--provider'] } : {}) });
    console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; return;
  }
  if (calendarAction) { if (calendar) throw new Error('ASSISTANT_USAGE_INVALID'); await calendarCommand(calendarAction, values['--directory'], values['--owner'], recover); return; }
  const host = await startAssistantHost({ directory: values["--directory"], ownerId: values["--owner"], recover,
    ...(web ? { web: { port: Number(values["--web-port"] ?? 0) } } : {}),
    ...(config ? { modules: config.modules, ...(config.compatibleProvider ? { compatibleProvider: config.compatibleProvider } : {}) } : {}),
    ...(calendar ? { calendar: calendarEnvironment(values["--calendar-id"]) } : {}),
    ...(values["--telegram-owner"] ? { telegram: { token: process.env.ASSISTANT_TELEGRAM_BOT_TOKEN ?? "", expectedUserId: values["--telegram-owner"] } } : {}),
    engine: { ...(values["--provider"] ? { provider: values["--provider"] } : {}), ...(values["--model"] ? { model: values["--model"] } : {}) } });
  console.log(JSON.stringify({ kind: "assistant-ready", credentialsPath: host.credentialsPath, ...host.diagnostics() }));
  if (host.webUrl) console.log(JSON.stringify({ kind: "assistant-web", url: host.webUrl, instruction: "Abrí este enlace privado en el navegador local." }));
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
