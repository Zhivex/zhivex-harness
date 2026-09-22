import { loadModelCatalog } from "../../src/internal/desktop/providers.js";
import { externalUrl } from "./external-url.js";
import {verifyDesktopModelsSmoke} from "./smoke-models-verification.js";
import {desktopProviders, defaultModelSelection, modelSelectionSchema} from "./model-selection.js";
import {prepareModelTransition, sameModel} from "./model-transition.js";
import {resumeDesktopUpdateRecovery} from "./update-recovery.js";
import {checkDesktopStateFormat, DesktopStateError} from "./state-format.js";
import updateTrust from "../update-trust.json";
import desktopMetadata from "../package.json";
import {parseDesktopUpdateTrust} from "./update-trust.js";
import {createDesktopUpdateInstaller, DesktopInstallError} from "./update-install.js";
import {createDesktopUpdateSession} from "./update-session.js";
import {createDesktopUpdateFeed} from "./update-feed.js";
import {registerDesktopUpdateIpc} from "./update-ipc.js";
import {openCredentialStore} from "./credential-store.js";
import {credentialCoordinator} from "./credential-coordinator.js";
import {registerPullRequestIpc} from "./pr-ipc.js";
import { openGitHubGitTransport } from "./github-git-transport.js";
import { openRemoteDelivery } from "./remote-delivery.js";
import { openGitDelivery } from "./git-delivery.js";
import { hostSensitiveValues } from "./redaction.js";
import { verifyDesktopWorktreesSmoke } from "./smoke-worktrees-verification.js";
import { verifyDesktopOciSmoke } from "./smoke-oci-verification.js";
import { verifyDesktopRestartSmoke } from "./smoke-restart-verification.js";
import { verifyDesktopEffectCrashSmoke } from "./smoke-effect-crash-verification.js";
import { openTaskWorktrees, type ManagedTask } from "./task-worktrees.js";
import type { DesktopTask } from "./bridge.js";
import { prepareDesktopShutdown } from "./shutdown.js";
import { app, BrowserWindow, ipcMain, session, dialog, shell, clipboard } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openProjectRegistry } from "./projects.js";
import { launchProjectRuntime, type ProjectRuntime } from "./runtime-host.js";
import { verifyDesktopSmoke } from "./smoke-verification.js";

const argument = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const fixture = process.argv.includes("--smoke-test"), workspaceArgument = argument("--workspace");
const reportDirectory = fixture ? argument("--report-directory") : undefined;
if (fixture && reportDirectory) app.setPath("userData", path.join(reportDirectory, "user-data"));
if (!app.requestSingleInstanceLock()) app.exit(0);
let mainWindow: BrowserWindow | undefined;
app.on("second-instance", () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
const runtimes = new Map<string, Promise<ProjectRuntime>>(); let closing = false, updating = false, modelChanging = false;
let exitApproved = false;
let requestExit = () => { exitApproved = true; app.quit(); };
app.on("before-quit", event => { if (!exitApproved) { event.preventDefault(); requestExit(); } });
void app.whenReady().then(async () => {
    try {await checkDesktopStateFormat(app.getPath("userData"));}
    catch (error) {
        const trust = parseDesktopUpdateTrust(updateTrust);
        if (!(error instanceof DesktopStateError) || error.code !== "DESKTOP_STATE_RECOVERY_REQUIRED" || !trust.enabled || !app.isPackaged) throw error;
        try {await resumeDesktopUpdateRecovery({userData: app.getPath("userData"), application: path.resolve(process.resourcesPath, "../.."), teamId: trust.teamId, version: desktopMetadata.version});}
        catch {throw error;}
        exitApproved = true; app.quit(); return;
    }
 const registry = await openProjectRegistry(path.join(app.getPath("userData"), "projects"));
    const tasks = await openTaskWorktrees(path.join(app.getPath("userData"), "tasks"));
    const taskView = (task: ManagedTask): DesktopTask => ({ id: task.id, sourceProjectKey: task.sourceProjectKey, title: task.title, branch: task.branch, baseCommit: task.baseCommit, workspace: task.workspace, status: task.status });
    const taskOperations = new Set<Promise<unknown>>(), removing = new Set<string>();
    const trackTask = async<T>(operation: Promise<T>) => { taskOperations.add(operation); try { return await operation; } finally { taskOperations.delete(operation); } };
    // Track every application IPC, including reads that reconcile persisted metadata.
    const workIpc: Pick<typeof ipcMain, "handle"> = {handle(channel, listener) {
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
            validateSender(event);
            return trackTask(Promise.resolve(listener(event, ...args)));
        });
    }};
    const sourceProject = (key: string) => { const project = registry.get(key), task = tasks.list().find(task => task.workspace === project.workspace); return task ? registry.get(task.sourceProjectKey) : project; };
    const directory = fixture && reportDirectory ? path.join(reportDirectory, "socket") : `/tmp/zhx-desktop-${process.getuid?.()}`;
    const buildDirectory = path.join(app.getAppPath(), "build");
    const connect = async (key: string) => {
 if(credentials.changing)throw new Error("CREDENTIAL_WORK_ACTIVE");
        if (closing) throw new Error("APPLICATION_CLOSING");
        const known = registry.get(key);
        let project = await registry.select(known.workspace);
        if (project.key !== key) throw new Error("PROJECT_IDENTITY_CHANGED");
        if (closing || removing.has(project.workspace)) throw new Error("PROJECT_UNAVAILABLE");
        const task = tasks.list().find(task => task.workspace === project.workspace);
        if (task) {await tasks.inspect(task.id);if (!project.modelSelection) project = await registry.setModel(project.key, registry.get(task.sourceProjectKey).modelSelection ?? defaultModelSelection());}
        if (closing || removing.has(project.workspace)) throw new Error("PROJECT_UNAVAILABLE");
        let pending = runtimes.get(key);
        if (pending && !((await pending).isAlive())) { runtimes.delete(key); pending = undefined; }
        if (closing || removing.has(project.workspace)) throw new Error("PROJECT_UNAVAILABLE");
        if(credentials.changing)throw new Error("CREDENTIAL_WORK_ACTIVE");
if (!pending) { pending = launchProjectRuntime(project, {credentialHelper:app.isPackaged?path.join(process.resourcesPath,"credential-store"):path.join(buildDirectory,"credential-store"), buildDirectory, directory, fixture, ...(task ? { stateDirectory: task.stateDirectory } : {}), fixtureOci: fixture && process.argv.includes("--fixture-oci"), fixtureEffectCrash: fixture && process.argv.includes("--fixture-effect-crash"), recover: true }); runtimes.set(key, pending); void pending.catch(() => { if (runtimes.get(key) === pending) runtimes.delete(key); }); }
        return { ...(await pending).context, ...(task ? { task: taskView(task) } : {}) };
    };
    const runtime = async (key: unknown) => {if(credentials.changing)throw new Error("CREDENTIAL_WORK_ACTIVE"); if (typeof key !== "string" || !runtimes.has(key)) throw new Error("PROJECT_NOT_OPEN"); return runtimes.get(key)!; };
    const index = path.join(buildDirectory, "index.html"), url = pathToFileURL(index).href;
    const window = new BrowserWindow({ width: 1120, height: 760, minWidth: 720, minHeight: 520, show: false, backgroundColor: "#101315", title: "Zhivex Harness", webPreferences: { preload: path.join(buildDirectory, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
    mainWindow = window;
    const fixtureCloseChoices = fixture ? (argument("--fixture-close-choices") ?? "").split(",") : [];
    requestExit = () => {
        if (updating) {
            if (updateSession.state().status === "recovery-required") {exitApproved = true; app.quit();}
            return;
        }
        if (closing || exitApproved) return; closing = true;
        void (async () => {
            await Promise.allSettled([...taskOperations]);
            const hosts = await Promise.allSettled([...runtimes.values()]);
            const ready = hosts.flatMap(host => host.status === "fulfilled" ? [host.value] : []);
            const approved = await prepareDesktopShutdown(ready, async () => {
                const response = fixture ? (fixtureCloseChoices.shift() === "cancel" ? 1 : 0) : (await dialog.showMessageBox(window, { type: "question", title: "Work in progress", message: "Your projects have active operations.", detail: "Return to the app or request cancellation before quitting. Cancelling does not undo changes already made. If operations do not stop, the window will remain open.", buttons: ["Return to app", "Cancel work and quit"], defaultId: 0, cancelId: 0, noLink: true })).response;
                return response === 1 ? "cancel" : "stay";
            });
            if (approved) { await Promise.allSettled([...remoteManagers.values()].map(async pending => (await pending).transport.close())); remoteManagers.clear(); runtimes.clear(); exitApproved = true; app.quit(); }
        })().catch(async () => { if (!fixture && !window.isDestroyed()) await dialog.showMessageBox(window, { type: "warning", title: "The application is still open", message: "Completion of all work has not been confirmed.", detail: "Check your projects before quitting again. No shutdown was forced and no operations were repeated.", buttons: ["Return to app"] }); }).finally(() => { if (!exitApproved) closing = false; });
    };
    window.on("close", event => { if (!exitApproved) { event.preventDefault(); requestExit(); } });
    let recoveringRenderer = false;
    window.webContents.on("render-process-gone", () => {
        if (closing || recoveringRenderer || window.isDestroyed()) return;
        recoveringRenderer = true;
        void (async () => {
            // Fixture selection is host-only; the production action is a native dialog.
            const response = fixture ? 0 : (await dialog.showMessageBox(window, { type: "error", title: "The conversation stopped responding", message: "The conversation window closed unexpectedly.", detail: "The service may still be working. Reloading restores the saved state without submitting your task again.", buttons: ["Reload conversation", "Quit application"], defaultId: 0, cancelId: 1, noLink: true })).response;
            if (closing || window.isDestroyed()) return;
            if (response === 0) window.webContents.reload(); else app.quit();
        })().catch(() => app.quit()).finally(() => { recoveringRenderer = false; });
    });
    const validateOrigin = (event: Electron.IpcMainInvokeEvent) => { if (closing || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== url) throw new Error("UNTRUSTED_SENDER"); };
    const validateSender = (event: Electron.IpcMainInvokeEvent) => {validateOrigin(event); if (updating) throw new Error("UPDATE_IN_PROGRESS"); if (modelChanging) throw new Error("MODEL_CHANGE_IN_PROGRESS");};
    workIpc.handle("harness:open-external", async (_event, value: unknown) => {
        const url = externalUrl(value); if (!url) throw new Error("INVALID_EXTERNAL_URL");
        await shell.openExternal(url);
    });
    workIpc.handle("harness:copy-text", (_event, value: unknown) => {
        if (typeof value !== "string" || value.length > 1048576) throw new Error("INVALID_CLIPBOARD_TEXT");
        clipboard.writeText(value);
    });
    const trustedUpdates = parseDesktopUpdateTrust(process.platform === "darwin" && process.arch === "arm64" ? updateTrust : {schemaVersion: 1, enabled: false});
    const updateFeed = createDesktopUpdateFeed(trustedUpdates, desktopMetadata.version);
    const installer = createDesktopUpdateInstaller({application: path.resolve(process.resourcesPath, "../.."), userData: app.getPath("userData"), teamId: trustedUpdates.enabled ? trustedUpdates.teamId : "", version: desktopMetadata.version}, {
        busy: () => closing || taskOperations.size > 0 || deliveryBusy.size > 0 || credentials.changing,
        block: value => {updating = value;},
        hosts: () => Promise.all([...runtimes.values()]),
        inventory: () => ({projects: registry.list(), tasks: tasks.list()}),
        closeTransports: async () => {for (const pending of remoteManagers.values()) await (await pending).transport.close(); remoteManagers.clear();},
        clearHosts: () => runtimes.clear(),
        reload: () => {if (!window.isDestroyed()) window.webContents.reload();},
        quit: () => {exitApproved = true; app.quit();},
    });
    const updateSession = createDesktopUpdateSession(updateFeed, {directory: path.join(app.getPath("userData"), "update-downloads"), install: async prepared => {
        if (!app.isPackaged || !trustedUpdates.enabled) throw new DesktopInstallError("install-failed");
        await installer(prepared);
    }});
    registerDesktopUpdateIpc(ipcMain, validateOrigin, updateSession);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false)); session.defaultSession.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", event => event.preventDefault()); window.webContents.on("will-attach-webview", event => event.preventDefault());
    const remoteManagers = new Map<string, Promise<{ transport: Awaited<ReturnType<typeof openGitHubGitTransport>>; manager: Awaited<ReturnType<typeof openRemoteDelivery>> }>>();
    const remoteDelivery = async (key: string) => { if (closing) throw new Error("APPLICATION_CLOSING"); const project = registry.get(key); if (removing.has(project.workspace)) throw new Error("PROJECT_UNAVAILABLE"); const task = tasks.list().find(task => task.workspace === project.workspace); if (task) await tasks.inspect(task.id); let pending = remoteManagers.get(key); if (!pending) { pending = (async () => { const transport = await openGitHubGitTransport(project.workspace); try { return { transport, manager: await openRemoteDelivery(path.join(app.getPath("userData"), "remote-delivery", key), transport, hostSensitiveValues(process.env)) }; } catch (error) { await transport.close(); throw error; } })(); remoteManagers.set(key, pending); void pending.catch(() => remoteManagers.delete(key)); } return pending; };
    let fixturePushResponseDropped = false;
    let fixtureGitResponseDropped = false;
    const deliveryManagers = new Map<string, Promise<Awaited<ReturnType<typeof openGitDelivery>>>>(), deliveryBusy = new Set<string>();
    const delivery = async (key: string) => { const project = registry.get(key); if (removing.has(project.workspace)) throw new Error("PROJECT_UNAVAILABLE"); const task = tasks.list().find(task => task.workspace === project.workspace); if (task) await tasks.inspect(task.id); let manager = deliveryManagers.get(key); if (!manager) { manager = openGitDelivery(project.workspace, path.join(app.getPath("userData"), "git-delivery", key), hostSensitiveValues(process.env)); deliveryManagers.set(key, manager); void manager.catch(() => deliveryManagers.delete(key)); } return manager; };
    const gitPayload = (event: Electron.IpcMainInvokeEvent, value: unknown, fields: string[]) => { validateSender(event); if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== fields.sort().join(",")) throw new Error("INVALID_GIT_REQUEST"); const payload = value as Record<string, unknown>; if (typeof payload.projectKey !== "string") throw new Error("INVALID_PROJECT"); registry.get(payload.projectKey); return payload as Record<string, unknown> & { projectKey: string }; };
    const credentialHelper = app.isPackaged ? path.join(process.resourcesPath,"credential-store") : path.join(buildDirectory,"credential-store");
    const credentialStore = (provider: string) => openCredentialStore(credentialHelper, {provider});
 const credentials=credentialCoordinator({busy:()=>closing||taskOperations.size>0||deliveryBusy.size>0,hosts:()=>Promise.all([...runtimes.values()]),clear:()=>runtimes.clear(),configure:provider=>fixture?Promise.resolve("unsupported"):credentialStore(provider).configure(),delete:provider=>fixture?Promise.resolve("unsupported"):credentialStore(provider).delete()});
 const credentialRequest=(event:Electron.IpcMainInvokeEvent,args:unknown[])=>{validateSender(event);if(args.length>1)throw new Error("INVALID_CREDENTIAL_REQUEST");return modelSelectionSchema.shape.provider.parse(args[0] ?? "openai");};
 workIpc.handle("harness:credential-status",(event,...args:unknown[])=>{const p=credentialRequest(event,args);return fixture?Promise.resolve("unsupported"):credentialStore(p).status();});
 workIpc.handle("harness:credential-probe",(event,...args:unknown[])=>{const p=credentialRequest(event,args);return fixture?Promise.resolve("unsupported"):credentialStore(p).probe();});
 workIpc.handle("harness:credential-configure",(event,...args:unknown[])=>{const p=credentialRequest(event,args);return credentials.change("configure",p);});
 workIpc.handle("harness:credential-delete",(event,...args:unknown[])=>{const p=credentialRequest(event,args);return credentials.change("delete",p);});
 workIpc.handle("harness:providers", async (_event,...args:unknown[]) => {if(args.length)throw new Error("INVALID_PROVIDER_REQUEST");const snapshot = await loadModelCatalog();return desktopProviders(snapshot.catalog).map(p => ({...p, catalogSource: snapshot.source, catalogStale: snapshot.stale}));});
 workIpc.handle("harness:select-model", async (event,value:unknown) => {
    const payload = gitPayload(event,value,["projectKey","selection"]);
    const selection = modelSelectionSchema.parse(payload.selection);
    const project = registry.get(payload.projectKey);
    const previous = project.modelSelection ?? defaultModelSelection();
    if (sameModel(previous,selection)) return connect(project.key);
    if (credentials.changing || taskOperations.size || deliveryBusy.size) throw new Error("MODEL_WORK_ACTIVE");
    modelChanging = true;
    let old: ProjectRuntime | undefined, next: ProjectRuntime | undefined, closed = false;
    try {
        // Validate access before stopping a working runtime. No secret is returned to the UI.
        if (!fixture && !["present","missing"].includes(await credentialStore(selection.provider).status())) throw new Error("MODEL_CREDENTIAL_UNAVAILABLE");
        await connect(project.key);
        old = await runtimes.get(project.key);
        if (old) {await prepareModelTransition(old); await old.close(); closed = true; runtimes.delete(project.key);}
        const task = tasks.list().find(t => t.workspace === project.workspace);
        const pending = launchProjectRuntime({...project,modelSelection:selection},{credentialHelper,buildDirectory,directory,fixture,recover:true,...(task?{stateDirectory:task.stateDirectory}:{})});
        next = await pending;
        const saved = await registry.setModel(project.key, selection);
        runtimes.set(project.key,Promise.resolve(next));
        return {...next.context,project:saved,...(task?{task:taskView(task)}:{})};
    } catch (error) {
        if (next) await next.close();
        if (closed) {
            runtimes.delete(project.key);
            try {await connect(project.key);} catch {/* The UI can explicitly reopen the project. */}
        }
        throw error;
    } finally {modelChanging = false;}
 });
 const gitMutation = async<T>(key: string, operation: (manager: Awaited<ReturnType<typeof openGitDelivery>>) => Promise<T>) => {
        if (deliveryBusy.has(key)) throw new Error("GIT_DELIVERY_BUSY"); deliveryBusy.add(key); let host: ProjectRuntime | undefined;
        try { host = await runtime(key); if (await host.controlClose("pause")) throw new Error("GIT_RUNTIME_BUSY"); return await operation(await delivery(key)); } finally { if (host?.isAlive() && !closing) await host.controlClose("resume").catch(() => { }); deliveryBusy.delete(key); }
    };
    workIpc.handle("harness:git-changes", async (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey"]); return (await delivery(payload.projectKey)).changes(); });
    workIpc.handle("harness:git-stage", (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "paths"]); return trackTask(gitMutation(payload.projectKey, manager => manager.stage(payload.paths))); });
    workIpc.handle("harness:git-review-commit", async (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "input"]); return (await delivery(payload.projectKey)).reviewCommit(payload.input); });
    workIpc.handle("harness:git-commit", (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "ticketId"]); if (typeof payload.ticketId !== "string") throw new Error("INVALID_GIT_REQUEST"); const ticketId = payload.ticketId; return trackTask(gitMutation(payload.projectKey, async manager => { const result = await manager.commit(ticketId); if (fixture && process.argv.includes("--fixture-drop-git-response") && !fixtureGitResponseDropped) { fixtureGitResponseDropped = true; throw new Error("GIT_RESPONSE_LOST"); } return result; })); });
    workIpc.handle("harness:git-reconcile", async (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "operationId"]); if (typeof payload.operationId !== "string") throw new Error("INVALID_GIT_REQUEST"); return (await delivery(payload.projectKey)).reconcile(payload.operationId); });
    workIpc.handle("harness:remote-targets", (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey"]); return trackTask((async () => (await remoteDelivery(payload.projectKey)).transport.targets())()); });
    workIpc.handle("harness:review-push", (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "destination"]); return trackTask((async () => (await remoteDelivery(payload.projectKey)).manager.reviewPush(payload.destination))()); });
    workIpc.handle("harness:push", (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "ticketId"]); if (typeof payload.ticketId !== "string") throw new Error("INVALID_PUSH_REQUEST"); const id = payload.ticketId; return trackTask(gitMutation(payload.projectKey, async () => { const result = await (await remoteDelivery(payload.projectKey)).manager.push(id); if (fixture && process.argv.includes("--fixture-drop-push-response") && !fixturePushResponseDropped) { fixturePushResponseDropped = true; throw new Error("PUSH_RESPONSE_LOST"); } return result; })); });
    workIpc.handle("harness:reconcile-push", (event, value: unknown) => { const payload = gitPayload(event, value, ["projectKey", "operationId"]); if (typeof payload.operationId !== "string") throw new Error("INVALID_PUSH_REQUEST"); const id = payload.operationId; return trackTask((async () => (await remoteDelivery(payload.projectKey)).manager.reconcile(id))()); });
    registerPullRequestIpc({payload:gitPayload,remote:remoteDelivery,mutate:(key,operation)=>gitMutation(key,operation),track:trackTask,directory:path.join(app.getPath("userData"),"pull-requests"),dropResponse:fixture&&process.argv.includes("--fixture-drop-pr-response"),...(fixture&&reportDirectory?{fixtureDirectory:reportDirectory}:{})});
    workIpc.handle("harness:projects", event => { validateSender(event); const managed = new Set(tasks.list().map(task => task.workspace)); return registry.list().filter(project => !managed.has(project.workspace)); });
    workIpc.handle("harness:tasks", (event, key: unknown) => { validateSender(event); if (typeof key !== "string") throw new Error("INVALID_PROJECT"); return tasks.list(sourceProject(key).key).map(taskView); });
    workIpc.handle("harness:create-task", (event, value: unknown) => {
        validateSender(event); if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "input,projectKey") throw new Error("INVALID_TASK");
        const payload = value as { projectKey: unknown; input: unknown }; if (typeof payload.projectKey !== "string") throw new Error("INVALID_PROJECT");
        return trackTask(tasks.create(sourceProject(payload.projectKey), payload.input).then(taskView));
    });
    workIpc.handle("harness:open-task", async (event, id: unknown) => { validateSender(event); if (typeof id !== "string") throw new Error("INVALID_TASK"); const task = tasks.get(id); if (task.status !== "ready" || removing.has(task.workspace)) throw new Error("TASK_NOT_READY"); const project = await registry.select(task.workspace); return connect(project.key); });
    const removalTickets = new Map<string, string>();
    workIpc.handle("harness:review-task-removal", async (event, id: unknown) => { validateSender(event); if (typeof id !== "string") throw new Error("INVALID_TASK"); const review = await tasks.reviewRemoval(id); removalTickets.set(review.ticketId, id); while (removalTickets.size > 128) removalTickets.delete(removalTickets.keys().next().value!); return { ...review, task: taskView(review.task) }; });
    workIpc.handle("harness:remove-task", (event, ticketId: unknown) => {
        validateSender(event); if (typeof ticketId !== "string" || !removalTickets.has(ticketId)) throw new Error("TASK_REVIEW_REQUIRED"); const id = removalTickets.get(ticketId)!; removalTickets.delete(ticketId);
        return trackTask((async () => {
            const task = tasks.get(id); if (removing.has(task.workspace) || [...deliveryBusy].some(key => registry.get(key).workspace === task.workspace)) throw new Error("TASK_BUSY"); removing.add(task.workspace);
            const project = registry.list().find(project => project.workspace === task.workspace); const pending = project ? runtimes.get(project.key) : undefined; let host: ProjectRuntime | undefined;
            try {
                if (pending) { host = await pending; if (await host.controlClose("pause")) throw new Error("TASK_BUSY"); await host.close(); runtimes.delete(project!.key); }
                return taskView(await tasks.remove(ticketId));
            } finally { if (host?.isAlive()) await host.controlClose("resume").catch(() => { }); removing.delete(task.workspace); }
        })());
    });
    workIpc.handle("harness:initial-project", async event => { validateSender(event); return workspaceArgument ? connect((await registry.select(workspaceArgument)).key) : null; });
    workIpc.handle("harness:open-project", async (event, key: unknown) => { validateSender(event); if (typeof key !== "string") throw new Error("INVALID_PROJECT"); return connect(key); });
    const fixtureProjects = fixture ? process.argv.flatMap((value, index) => value === "--fixture-project" && process.argv[index + 1] ? [process.argv[index + 1]!] : []) : [];
    let choosing = false;
    workIpc.handle("harness:choose-project", async event => {
        validateSender(event); if (choosing) throw new Error("PROJECT_PICKER_BUSY"); choosing = true;
        try {
            // Only host-launch fixture paths can replace the native picker in packaged tests.
            const fixturePath = fixtureProjects.shift();
            const result = fixture ? { canceled: !fixturePath, filePaths: fixturePath ? [fixturePath] : [] } : await dialog.showOpenDialog(window, { title: "Open repository", buttonLabel: "Open project", properties: ["openDirectory"] });
            if (result.canceled || !result.filePaths[0]) return null;
            return connect((await registry.select(result.filePaths[0])).key);
        } finally { choosing = false; }
    });
    workIpc.handle("harness:command", async (event, payload: unknown) => {
        validateSender(event); if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "command,projectKey") throw new Error("INVALID_COMMAND");
        const value = payload as { projectKey: unknown; command: unknown }; if (value.command && typeof value.command === "object" && "method" in value.command && value.command.method === "approval.resolve") throw new Error("REVIEW_REQUIRED"); return (await runtime(value.projectKey)).command(value.command);
    });
    workIpc.handle("harness:review", async (event, payload: unknown) => {
        validateSender(event); if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "projectKey,runId,sessionId") throw new Error("INVALID_REVIEW");
        const value = payload as { projectKey: unknown; sessionId: unknown; runId: unknown }; return (await runtime(value.projectKey)).review(value.sessionId, value.runId);
    });
    workIpc.handle("harness:resolve-review", async (event, payload: unknown) => {
        validateSender(event); if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "approve,projectKey,ticketId") throw new Error("INVALID_DECISION");
        const value = payload as { projectKey: unknown; ticketId: unknown; approve: unknown }; return (await runtime(value.projectKey)).resolveReview(value.ticketId, value.approve);
    });
    workIpc.handle("harness:events", async (event, payload: unknown) => {
        validateSender(event); if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "after,projectKey,sessionId") throw new Error("INVALID_CURSOR");
        const value = payload as { projectKey: unknown; sessionId: unknown; after: unknown }; return (await runtime(value.projectKey)).events({ sessionId: value.sessionId, after: value.after });
    });
    window.once("ready-to-show", () => window.show()); await window.loadFile(index);
    if (fixture && reportDirectory) { await mkdir(reportDirectory, { recursive: true }); const restartPhase = argument("--fixture-restart-phase"); if (restartPhase?.startsWith("tasks-")) await verifyDesktopWorktreesSmoke(window, runtimes, reportDirectory, restartPhase); else if (restartPhase?.startsWith("effect-")) await verifyDesktopEffectCrashSmoke(window, runtimes, reportDirectory, restartPhase); else if (restartPhase) await verifyDesktopRestartSmoke(window, runtimes, reportDirectory, restartPhase, argument("--fixture-cli")); else { await (process.argv.includes("--fixture-models") ? verifyDesktopModelsSmoke : process.argv.includes("--fixture-oci") ? verifyDesktopOciSmoke : verifyDesktopSmoke)(window, runtimes, reportDirectory); app.quit(); } }
}).catch(async (error) => { if(error instanceof DesktopStateError){ if(!fixture) dialog.showErrorBox("Cannot open this state", "This version cannot open the saved state or a migration requires recovery. Use a compatible version and preserve your data and backups. Code: " + error.code); if(reportDirectory) await writeFile(path.join(reportDirectory,"state-format-failure.json"),JSON.stringify({code:error.code})).catch(()=>{}); app.exit(1); return; } if (fixture) console.error(error); if (reportDirectory) await writeFile(path.join(reportDirectory, "failure.json"), JSON.stringify({ code: "DESKTOP_VERIFICATION_FAILED" })).catch(() => { }); process.stderr.write("Desktop could not start or verify. Check workspace access and runtime ownership.\n"); app.exit(1); });
app.on("window-all-closed", () => app.quit());
