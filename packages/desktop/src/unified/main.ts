import { createCheckpointReviewHost } from '@zhivex-ai/harness/application';
import { app, BrowserWindow, ipcMain, session, Menu, dialog, shell, Tray, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";
import { createManagedRuntime, type RuntimeSnapshot } from "./managed-runtime.js";
import { pathToFileURL } from "node:url";
import { connectApplication, type ApplicationClient } from "@zhivex-ai/harness/application/client";
import { z } from "zod";
import { desktopRedactor, hostSensitiveValues } from "../redaction.js";
import { readHarnessLocalCredentials } from "@zhivex-ai/harness/application/client";
import { checkDesktopStateFormat } from "../state-format.js";
import type { UnifiedHost } from "./bridge.js";

const argument = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const userData = argument("--user-data");
if (userData) app.setPath("userData", path.resolve(userData));
let window: BrowserWindow | undefined;
let statusTray: Tray | undefined;
const showWindow = () => { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
app.on('will-quit', () => { statusTray?.destroy(); statusTray = undefined; });
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", showWindow);
app.on("activate", showWindow);
let quitting = false;
let runtime: ReturnType<typeof createManagedRuntime> | undefined;
let closing = false, stopped = false;
let recovering: ReturnType<ReturnType<typeof createManagedRuntime>['reconnect']> | undefined;
const recoverRuntime = () => recovering ??= runtime!.reconnect().finally(() => { recovering = undefined; });
app.on("before-quit", event => {
  if (stopped || !runtime) { quitting = true; return; }
  event.preventDefault(); if (closing) return;
  closing = true;
  void (async () => {
    await recovering?.catch(() => {});
    if (!runtime!.ownsService()) { quitting = true; await runtime!.close(); stopped = true; app.quit(); return; }
    let activity = 'Current activity could not be read. Tasks may still be running.';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const summary = await Promise.race([runtime!.shutdownSummary(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SHUTDOWN_PREVIEW_TIMEOUT')), 3000); })]);
      activity = summary.runtimes.map(item => item.available
        ? `${item.area === 'assistant' ? 'Assistant' : 'Code'}: ${item.activeRuns} unfinished tasks (${item.pendingReviews} awaiting review).`
        : `${item.area === 'assistant' ? 'Assistant' : 'Code'}: activity unavailable.`).join('\n') || 'No active runtime.';
      if (summary.backgroundServices) activity += '\nAssistant background services are enabled.';
    } catch {} finally { if (timer) clearTimeout(timer); }
    const choice = await dialog.showMessageBox({ type: 'question', title: 'Quit Zhivex?', message: 'Stop the service and quit?',
      detail: `${activity}\n\nQuitting cancels running tasks, preserves pending reviews, and stops this app’s reminders, automations and integrations. Other clients using this service will disconnect. Work does not continue while the app is stopped. Saved conversations remain available.\n\nKeep running to continue in the background. Activity may change until you confirm.`,
      buttons: ['Keep running', 'Stop service and quit'], defaultId: 0, cancelId: 0, noLink: true });
    if (choice.response !== 1) { closing = false; return; }
    quitting = true;
    try { await runtime!.close(); }
    catch { dialog.showErrorBox('Service shutdown was interrupted', 'The runtime stopped before confirming a clean shutdown. On reopening, review uncertain operations before trying them again.'); }
    stopped = true; app.quit();
  })().catch(() => { closing = false; quitting = false; });
});

void app.whenReady().then(async () => {
  const applicationPath = app.getAppPath();
  const root = path.basename(applicationPath) === "build" ? applicationPath : path.join(applicationPath, "build");
  const appIcon = path.join(root, "zhivex-logo.png");
  if (process.platform === "darwin") app.dock?.setIcon(appIcon);
  const url = pathToFileURL(path.join(root, "unified.html")).href;
  await checkDesktopStateFormat(app.getPath("userData"));
  const clients = new Map<string, { descriptor: UnifiedHost; file: string; client: ApplicationClient; redact: ReturnType<typeof desktopRedactor> }>();
  for (const area of ["assistant", "code"] as const) {
    const file = argument(area === "assistant" ? "--assistant-service-file" : "--service-file");
    if (!file) continue;
    const client = await connectApplication(path.resolve(file));
    const credentials = await readHarnessLocalCredentials(path.resolve(file));
    clients.set(area, { descriptor: { id: area, area, projectId: client.projectId, label: area === "assistant" ? "Personal assistant" : "Code workspace" },
      file: path.resolve(file), client, redact: desktopRedactor([...hostSensitiveValues(process.env), credentials.token]) });
  }
  let runtimeReady = false, setupFailure = "", changing = false, codeChanging = false, gitChanging = false;
  const syncRuntime = async (snapshot: RuntimeSnapshot) => {
    const codeFile = snapshot.codeCredentialsPath;
    if (!codeFile) clients.delete("code");
    else if (clients.get("code")?.file !== codeFile) {
      const client = await connectApplication(codeFile), credentials = await readHarnessLocalCredentials(codeFile);
      clients.set("code", {descriptor: {id: "code", area: "code", projectId: client.projectId,
        label: snapshot.code.projects.find(project => project.id === snapshot.code.active)?.label ?? "Code workspace"},
        file: codeFile, client, redact: desktopRedactor([...hostSensitiveValues(process.env), credentials.token])});
    }
    if (!snapshot.credentialsPath) { clients.delete("assistant"); return; }
    const existing = clients.get("assistant");
    if (existing?.file === snapshot.credentialsPath) return;
    const client = await connectApplication(snapshot.credentialsPath);
    const credentials = await readHarnessLocalCredentials(snapshot.credentialsPath);
    clients.set("assistant", { descriptor: { id: "assistant", area: "assistant", projectId: client.projectId,
      label: snapshot.state.profiles.find(profile => profile.active)?.name ?? "Personal assistant" },
      file: snapshot.credentialsPath, client, redact: desktopRedactor([...hostSensitiveValues(process.env), credentials.token]) });
  };
  const boot = async () => {
    clients.delete("assistant"); clients.delete("code"); runtimeReady = false;
    runtime = createManagedRuntime(path.join(root, "unified-assistant-worker.cjs"), path.resolve(argument("--assistant-directory") ?? path.join(os.homedir(), ".zhx-app")), path.join(app.isPackaged ? process.resourcesPath : root, "credential-runtime", "worker.cjs"));
    try { const snapshot = await runtime.start(); runtimeReady = true; setupFailure = ""; await syncRuntime(snapshot); }
    catch (error) { setupFailure = error instanceof Error ? error.message : "ASSISTANT_START_FAILED"; }
  };
  if (!argument("--assistant-service-file") && !argument("--service-file")) await boot();

  const view = new BrowserWindow({ width: 1440, height: 960, minWidth: 390, minHeight: 520, show: false, title: "Zhivex", icon: appIcon, backgroundColor: "#f8f7f4",
    webPreferences: { preload: path.join(root, "unified-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
  window = view;
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", event => event.preventDefault());
  view.webContents.on("will-attach-webview", event => event.preventDefault());
  view.on("close", event => { if (!quitting) { event.preventDefault(); view.hide(); } });
  // Closing the window preserves background work. Quit closes only the owned runtime.
  // One menu and one shutdown path for the menu bar and the background status item.
  const lifecycleMenu = Menu.buildFromTemplate([
    {label: 'Zhivex runs while the app is open', enabled: false},
    {label: 'Closing the window keeps background work active', enabled: false},
    {type: 'separator'},
    {id: 'show-zhivex', label: 'Show Zhivex', click: showWindow},
    {id: 'hide-zhivex', label: 'Hide window', click: () => view.hide()},
    {type: 'separator'},
    {id: 'quit-zhivex', label: 'Quit Zhivex…', click: () => app.quit(), accelerator: 'CommandOrControl+Q'},
  ]);
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label: 'Zhivex', submenu: lifecycleMenu}, {role: 'editMenu'}, {role: 'viewMenu'}]));
  const statusIcon = nativeImage.createFromPath(path.join(root, 'statusTemplate.png'));
  if (statusIcon.isEmpty()) throw new Error('STATUS_ICON_UNAVAILABLE');
  statusIcon.setTemplateImage(true);
  statusTray = new Tray(statusIcon);
  statusTray.setToolTip('Zhivex — open app or manage background service');
  statusTray.setContextMenu(lifecycleMenu);
  statusTray.on('double-click', showWindow);
  const host = (id: unknown) => { if ((changing && id === "assistant") || (codeChanging && id === "code")) throw new Error("SETUP_BUSY"); const found = typeof id === "string" ? clients.get(id) : undefined; if (!found) throw new Error("HOST_NOT_CONNECTED"); return found; };
  const handle = (channel: string, fn: (...values: unknown[]) => unknown) => ipcMain.handle(channel, (event, ...values: unknown[]) => {
    if (quitting || closing || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || event.senderFrame.url !== url) throw new Error("UNTRUSTED_SENDER");
    return fn(...values);
  });
  handle('application:catalog', async () => {
    if (!runtime) return null;
    if (!runtimeReady || changing || codeChanging) throw new Error('APPLICATION_UNAVAILABLE');
    return runtime.catalog();
  });
  handle("application:setup-state", async () => {
    if (!runtime) return null;
    if (!runtimeReady) throw new Error(setupFailure);
    const snapshot = await runtime.state(); await syncRuntime(snapshot); return snapshot.state;
  });
  handle('application:agenda', async (projectId, date, timeZone) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    return entry.redact.redact(await runtime.agenda({projectId, date, timeZone}));
  });
  handle('application:automation', async (projectId, change) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || codeChanging || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    if (change !== undefined) changing = true;
    try { return entry.redact.redact(await runtime.automation({projectId, ...(change === undefined ? {} : {change})})); }
    finally { if (change !== undefined) changing = false; }
  });
  handle('application:notes', async (projectId, options) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    const parsed = z.object({query: z.string().max(200).optional(), offset: z.number().int().min(0).max(10000).optional(), noteId: z.string().uuid().optional()}).strict().parse(options);
    return entry.redact.redact(await runtime.notes({...parsed, projectId}));
  });
  handle('application:reply-watch-proposal', async (projectId, watch) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    return runtime.prepareReplyWatch({projectId, watch});
  });
  handle('application:mail-draft-proposal', async (projectId, provider, draft) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    return runtime.prepareMailDraft({projectId, provider, draft});
  });
  handle('application:calendar-create-proposal', async (projectId, event) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    return runtime.prepareCalendarCreation({projectId, event});
  });
  handle('application:personal-state', async (projectId, offset) => {
    const entry = host('assistant');
    if (!runtime || !runtimeReady || changing || entry.descriptor.projectId !== projectId) throw new Error('ASSISTANT_UNAVAILABLE');
    const input = z.object({projectId: z.string(), offset: z.number().int().min(0).max(10000)}).parse({projectId, offset});
    return entry.redact.redact(await runtime.personalState(input));
  });
  handle('application:open-calendar', async () => {
    if (!runtime || !runtimeReady || changing) throw new Error('ASSISTANT_UNAVAILABLE');
    const authorization = await runtime.authorization();
    if (!authorization.url) throw new Error('CALENDAR_AUTHORIZATION_UNAVAILABLE');
    const url = new URL(authorization.url);
    const google = url.hostname === 'accounts.google.com' && url.pathname === '/o/oauth2/v2/auth';
    const microsoft = url.hostname === 'login.microsoftonline.com' && /^\/[A-Za-z0-9.-]+\/oauth2\/v2\.0\/authorize$/.test(url.pathname);
    if (url.protocol !== 'https:' || (!google && !microsoft) || url.port || url.username || url.password || url.hash) throw new Error('CALENDAR_AUTHORIZATION_INVALID');
    await shell.openExternal(url.href);
  });
  handle('application:open-telegram', async () => {
    if (!runtime || !runtimeReady || changing) throw new Error('ASSISTANT_UNAVAILABLE');
    const url = (await runtime.state()).state.telegram.url;
    if (!url || !/^https:\/\/t\.me\/[A-Za-z0-9_]{5,64}\?start=[a-f0-9]{32}$/.test(url)) throw new Error('TELEGRAM_PAIRING_UNAVAILABLE');
    await shell.openExternal(url);
  });
  const setupActions = new Set(["edit-integrations", "integration-remove", "reuse-provider", "agent-update", "google", "microsoft", "microsoft-reconnect", "calendar", "calendar-cancel", "telegram", "telegram-check", "telegram-confirm", "telegram-cancel", "telegram-remove", "retry", "begin", "rename", "provider", "tools", "start", "select", "discard", "connection-select"]);
  handle("application:setup-action", async (name, value) => {
    if (!runtime || typeof name !== "string" || !setupActions.has(name) || changing) throw new Error("SETUP_ACTION_INVALID");
    changing = true;
    try {
      if ((!runtimeReady || !runtime.isAlive()) && name === "retry") { await runtime.close(); await boot(); if (!runtimeReady) throw new Error(setupFailure); }
      else {
        if (name === 'retry') { await recoverRuntime(); clients.clear(); }
        clients.delete("assistant"); await runtime.action(name, value);
      }
      const snapshot = await runtime.state(); await syncRuntime(snapshot); return snapshot.state;
    } finally {
      if (runtimeReady) { try { await syncRuntime(await runtime.state()); } catch {} }
      changing = false;
    }
  });
  handle("application:code-state", async () => {
    if (!runtime) return null;
    if (!runtimeReady) throw new Error(setupFailure);
    const snapshot = await runtime.state(); await syncRuntime(snapshot); return snapshot.code;
  });
  const codeOperation = async (method: 'code-configure' | 'code-open' | 'code-select' | 'code-retry', input?: unknown) => {
    if (!runtime || !runtimeReady || changing || codeChanging || gitChanging) throw new Error("CODE_UNAVAILABLE");
    codeChanging = true;
    try {
      clients.delete("code");
      if (!runtime.isAlive() && method === 'code-retry') { await runtime.close(); await boot(); if (!runtimeReady) throw new Error(setupFailure); }
      else {
        if (method === 'code-retry') { await recoverRuntime(); clients.clear(); }
        await runtime.code(method, input);
      }
      const snapshot = await runtime.state(); await syncRuntime(snapshot); return snapshot.code;
    } finally { try { await syncRuntime(await runtime.state()); } catch {} codeChanging = false; }
  };
  handle("application:code-open", async connectionId => {
    const id = z.string().regex(/^[a-f0-9]{24}$/).parse(connectionId);
    if (!runtime || changing || codeChanging || gitChanging) throw new Error("CODE_UNAVAILABLE");
    const selection = await dialog.showOpenDialog(view, {title: "Open Code project", properties: ["openDirectory"]});
    if (selection.canceled || !selection.filePaths[0]) return null;
    return codeOperation('code-open', {workspace: selection.filePaths[0], connectionId: id});
  });
  handle("application:code-configure", (id, connectionId) => codeOperation('code-configure', {id: z.string().regex(/^[a-f0-9]{24}$/).parse(id), connectionId: z.string().min(1).parse(connectionId)}));
  handle("application:code-select", id => codeOperation('code-select', {id: z.string().regex(/^[a-f0-9]{24}$/).parse(id)}));
  handle("application:code-retry", () => codeOperation('code-retry'));
  handle("application:hosts", async () => { if (runtime && runtimeReady && !changing && !codeChanging) await syncRuntime(await runtime.state()); return [...clients.values()].map(entry => entry.descriptor); });
  handle("application:reconnect", async id => {
    if (changing || codeChanging || gitChanging) throw new Error('SETUP_BUSY');
    const previous = host(id).descriptor.projectId;
    changing = true;
    try {
      if (runtime && runtimeReady) {
        const snapshot = await recoverRuntime();
        if (snapshot.recovered) clients.clear();
        await syncRuntime(snapshot);
      }
    } finally { changing = false; }
    const entry = host(id);
    if (entry.descriptor.projectId !== previous) throw new Error('HOST_IDENTITY_CHANGED');
    const client = await connectApplication(entry.file);
    if (client.projectId !== entry.descriptor.projectId) throw new Error("HOST_IDENTITY_CHANGED");
    const credentials = await readHarnessLocalCredentials(entry.file);
    entry.redact = desktopRedactor([...hostSensitiveValues(process.env), credentials.token]); entry.client = client;
  });
  handle('application:code-tools', async (action, value) => {
    if (!runtime || !runtimeReady || codeChanging || gitChanging || changing) throw new Error('CODE_UNAVAILABLE');
    if (typeof action !== 'string' || !['list', 'create', 'open', 'review-removal', 'remove', 'checks', 'context'].includes(action)) throw new Error('CODE_ACTION_INVALID');
    if (['open', 'review-removal', 'remove'].includes(action)) z.string().uuid().parse(value);
    if (action === 'context') {const scope = z.object({projectId: z.string().min(1)}).strict().parse(value); if (host('code').descriptor.projectId !== scope.projectId) throw new Error('APPLICATION_SCOPE_CHANGED');}
    const mutating = ['create', 'open', 'remove'].includes(action);
    if (mutating) codeChanging = true;
    try {
      const result = await runtime.tools(action, value);
      if (action === 'open') { clients.delete('code'); await syncRuntime(result as RuntimeSnapshot); return; }
      return hostRedact(result);
    } finally { if (mutating) codeChanging = false; }
  });
  const hostRedact = (value: unknown) => clients.get('code')?.redact.redact(value) ?? value;
  const deliveryActions = new Set(['changes', 'stage', 'review-commit', 'commit', 'reconcile-commit', 'targets', 'review-push', 'push', 'reconcile-push', 'review-pr', 'create-pr', 'reconcile-pr', 'open-pr']);
  handle('application:git', async (projectId, action, value) => {
    const entry = host('code');
    if (!runtime || !runtimeReady || entry.descriptor.projectId !== projectId || typeof action !== 'string' || !deliveryActions.has(action) || codeChanging || gitChanging || changing) throw new Error('GIT_UNAVAILABLE');
    const mutating = ['stage', 'review-commit', 'commit', 'review-push', 'push', 'review-pr', 'create-pr'].includes(action);
    if (mutating) gitChanging = true;
    try {
      const result = await runtime.delivery(action, value);
      if (action === 'open-pr') { if (typeof result !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(result)) throw new Error('PR_URL_INVALID'); await shell.openExternal(result); return; }
      return result;
    } finally { if (mutating) gitChanging = false; }
  });
  const checkpointHosts = new WeakMap<ApplicationClient, ReturnType<typeof createCheckpointReviewHost>>();
  const checkpointHost = (id: unknown) => {
    const entry = host(id); if (entry.descriptor.area !== 'code') throw new Error('CODE_REQUIRED');
    let review = checkpointHosts.get(entry.client);
    if (!review) { review = createCheckpointReviewHost(command => entry.client.command(command), value => entry.redact.redact(value)); checkpointHosts.set(entry.client, review); }
    return review;
  };
  handle('application:checkpoint-review', (id, sessionId, operationId) => checkpointHost(id).review(z.string().max(128).parse(sessionId), z.string().uuid().parse(operationId)));
  handle('application:checkpoint-recovery', (id, sessionId, operationId, child) => checkpointHost(id).reviewRecovery(z.string().max(128).parse(sessionId), z.string().uuid().parse(operationId), z.string().max(128).parse(child)));
  handle('application:checkpoint-resolve', (id, ticketId, approve) => checkpointHost(id).resolve(z.string().uuid().parse(ticketId), z.boolean().parse(approve)));
  const checkpointMethods = new Set(['checkpoint.list', 'checkpoint.inspect', 'checkpoint.capture', 'restore.prepare', 'restore.get']);
  const methods = new Set(["session.list", "session.create", "session.get", "session.rename", "run.get", "run.start", "run.cancel"]);
  handle("application:command", async (id, command) => {
    const parsed = z.object({ method: z.string() }).passthrough().parse(command);
    if ((!methods.has(parsed.method) && !checkpointMethods.has(parsed.method)) || "projectId" in parsed || parsed.includeReview === true) throw new Error("COMMAND_NOT_ALLOWED");
    const entry = host(id);
    if (checkpointMethods.has(parsed.method) && entry.descriptor.area !== 'code') throw new Error('CODE_REQUIRED');
    return entry.redact.response(await entry.client.command(parsed));
  });
  handle("application:events", async (id, sessionId, after) => {
    const input = z.object({ sessionId: z.string().min(1).max(128), after: z.number().int().nonnegative().safe() }).parse({ sessionId, after });
    const entry = host(id); return entry.redact.redact(await entry.client.events(input.sessionId, input.after));
  });
  handle("application:review", async (id, sessionId, runId) => {
    const input = z.object({ sessionId: z.string().min(1).max(128), runId: z.string().min(1).max(128) }).parse({ sessionId, runId });
    const result = await host(id).client.review(input.sessionId, input.runId);
    if (!result.ok) throw new Error(result.error.code);
    return result.review;
  });
  handle("application:decide", async (id, ticketId, approve) => {
    const input = z.object({ ticketId: z.string().uuid(), approve: z.boolean() }).parse({ ticketId, approve });
    const entry = host(id); return entry.redact.response(await entry.client.decide(input.ticketId, input.approve));
  });
  await view.loadURL(url); view.show();
}).catch(error => { console.error("UNIFIED_DESKTOP_START_FAILED", error instanceof Error ? error.message : "unknown"); dialog.showErrorBox("Zhivex could not start", "The desktop could not open. Close any other instance and try again."); void runtime?.close().finally(() => app.exit(1)); if (!runtime) app.exit(1); });
