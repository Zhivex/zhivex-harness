import { app, type BrowserWindow } from "electron";
import { readFile, writeFile, access ,unlink} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import type { ProjectRuntime } from "./runtime-host.js";
import type { DesktopTask } from "./bridge.js";

/** Offline host fixture: two UI-created tasks, separate workers and durable sessions. */
export async function verifyDesktopWorktreesSmoke(window: BrowserWindow, runtimes: Map<string, Promise<ProjectRuntime>>, directory: string, phase: string) {
    assert(["tasks-create", "tasks-reopen"].includes(phase));
    const js = (source: string) => window.webContents.executeJavaScript(source);
    const wait = async (source: string) => { for (let i = 0; i < 240; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); } await writeFile(path.join(directory, `${phase}-failure.txt`), await js("document.body.innerText")); throw new Error(`TASK_SMOKE_TIMEOUT: ${source}`); };
    const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const openVerifiedPr=async()=>{const filename=path.join(directory,"opened-pr.json");await unlink(filename).catch(error=>{if(error.code!=="ENOENT")throw error;});await click('[data-action="open-pr"]');for(let attempt=0;attempt<100;attempt++){try{assert.equal(JSON.parse(await readFile(filename,"utf8")).url,"https://github.com/fixture/repository/pull/1");return;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error("PR_OPEN_TIMEOUT");};
    const key = () => js('document.querySelector("main").dataset.projectKey') as Promise<string>;
    await wait('document.querySelector("[data-ready=true]") !== null');
    if (phase === "tasks-reopen") { await click('[data-project]'); }
    await wait('document.querySelector("[data-action=new-session]")?.disabled === false');
    const sourceKey = await key(), file = path.join(directory, "tasks-checkpoint.json");
    let saved: Array<{ task: DesktopTask; projectKey: string; sessionId: string; runId: string }> = [];
    const workers: ProjectRuntime[] = [];
    if (phase === "tasks-create") {
        for (const input of [{ title: "bad", initialState: "copy-dirty" }, { title: "bad", initialState: "committed-head", workspace: "/tmp/foreign" }]) assert(await js(`window.harness.createTask(${JSON.stringify(sourceKey)},${JSON.stringify(input)}).then(()=>false,()=>true)`));
        assert(await js('window.harness.openTask("unknown").then(()=>false,()=>true)'));
        assert(await js('window.harness.removeTask("unknown").then(()=>false,()=>true)'));
        for (let i = 0; i < 2; i++) {
            await js(`{const field=document.querySelector('[data-field="task-title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,${JSON.stringify("Tarea <img onerror=alert(1)> ")}+${i});field.dispatchEvent(new Event("input",{bubbles:true}));}`);
            await click('[data-field="task-policy"]'); await wait('document.querySelector("[data-action=create-task]").disabled === false'); await click('[data-action="create-task"]');
            await wait(`document.querySelector("main").dataset.projectKey !== ${JSON.stringify(i ? saved[0]!.projectKey : sourceKey)} && document.querySelector("[data-action=new-session]")?.disabled === false`);
            const projectKey = await key(), runtime = await runtimes.get(projectKey)!; workers.push(runtime);
            const tasks: DesktopTask[] = await js(`window.harness.tasks(${JSON.stringify(sourceKey)})`), task = tasks.find(t => t.workspace === runtime.context.project.workspace)!; assert(task); assert(!("stateDirectory" in task));
            assert.equal(await readFile(path.join(task.workspace, "review.txt"), "utf8"), "baseline\n"); assert.equal(await js('document.querySelectorAll(".task-panel img").length'), 0);
            await access(path.join(task.workspace, ".zhivex-harness")).then(() => assert.fail("State inside checkout"), () => { });
            await click('[data-action="new-session"]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)'); const sessionId: string = await js('document.querySelector("main").dataset.sessionId');
            await click('[data-action="wait"]'); await wait('document.querySelector("[data-action=cancel]").disabled === false');
            const result = await runtime.command({ method: "session.get", sessionId }); assert(result.ok && result.data.kind === "session"); const runId = result.data.session.runs[0]!.runId;
            saved.push({ task, projectKey, sessionId, runId });
        }
        assert.notEqual(workers[0]!.context.runtimePid, workers[1]!.context.runtimePid);
        for (let i = 0; i < 2; i++) {
            const item = saved[i]!, runtime = workers[i]!; const run = await runtime.command({ method: "run.get", sessionId: item.sessionId, runId: item.runId }); assert(run.ok && run.data.kind === "run"); assert.equal(run.data.run.status, "running");
            const foreign = await runtime.command({ method: "session.get", sessionId: saved[1 - i]!.sessionId }); assert.equal(foreign.ok, false);
        }
        await writeFile(path.join(saved[0]!.task.workspace, "review.txt"), "task one only\n"); assert.equal(await readFile(path.join(saved[1]!.task.workspace, "review.txt"), "utf8"), "baseline\n");
        assert(await js(`window.harness.gitStage(${JSON.stringify(saved[0]!.projectKey)},["review.txt"]).then(()=>false,error=>String(error).includes("GIT_RUNTIME_BUSY"))`));
        for (const item of saved) { await click(`[data-task="${item.task.id}"] [data-action="open-task"]`); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(item.projectKey)} && document.querySelector("[data-session]")?.disabled === false`); await click(`[data-session="${item.sessionId}"]`); await wait('document.querySelector("[data-action=cancel]").disabled === false'); await click('[data-action="cancel"]'); await wait('document.body.innerText.includes("cancelled")'); }
        const first = saved[0]!; await click(`[data-task="${first.task.id}"] [data-action="open-task"]`); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(first.projectKey)} && document.querySelector("[data-action=git-refresh]")?.disabled === false`);
        await click('.git-panel summary'); await click('[data-action="git-refresh"]'); await wait('document.querySelector("[data-git-path]") !== null'); await click('[data-git-path="review.txt"]'); await wait('document.querySelector("[data-action=git-stage]").disabled === false'); await click('[data-action="git-stage"]'); await wait('document.body.innerText.includes("Staged: select to review")'); await click('[data-git-path="review.txt"]');
        await js(`{const field=document.querySelector('[data-field="commit-message"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"Commit reviewed in UI");field.dispatchEvent(new Event("input",{bubbles:true}));}`);
        await wait('document.querySelector("[data-action=git-review]").disabled === false'); await click('[data-action="git-review"]'); await wait('document.querySelector("[data-action=git-commit]")?.disabled === false'); await click('[aria-label="Commit review"] details summary'); assert(await js('document.body.innerText.includes("task one only") && document.body.innerText.includes("baseline")'));
        await click('[data-action="git-commit"]'); await wait('document.querySelector("[data-action=git-reconcile]")?.disabled === false && document.querySelector(".git-panel [role=alert]") !== null');
        const loaded = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve())); window.webContents.reload(); await loaded; await wait('document.querySelector("[data-action=new-session]")?.disabled === false'); await wait(`document.querySelector('[data-task="${first.task.id}"] [data-action="open-task"]') !== null`); await click(`[data-task="${first.task.id}"] [data-action="open-task"]`); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(first.projectKey)} && document.querySelector("[data-action=git-reconcile]")?.disabled === false`); await click('.git-panel summary'); await click('[data-action="git-reconcile"]'); await wait('document.body.innerText.includes("Commit confirmed:")'); assert.equal(await readFile(path.join(saved[1]!.task.workspace, "review.txt"), "utf8"), "baseline\n");
        await click('.push-panel summary'); await wait('document.querySelector("[data-action=remote-targets]").disabled === false'); await click('[data-action="remote-targets"]'); await wait(`document.querySelector('[data-field="push-remote"] option[value="origin"]') !== null`);
        await js(`{const field=document.querySelector('[data-field="push-remote"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(field,"origin");field.dispatchEvent(new Event("change",{bubbles:true}));}`); await wait('document.querySelector("[data-action=review-push]").disabled === false'); await click('[data-action="review-push"]'); await wait('document.querySelector("[data-action=authorize-push]")?.disabled === false');
        await click('[aria-label="Push review"] > details > summary'); await click('[aria-label="Push review"] details details summary'); assert(await js('document.body.innerText.includes("task one only") && document.body.innerText.includes("https://github.com/fixture/repository.git")'));
        await click('[data-action="authorize-push"]'); await wait('document.querySelector("[data-action=reconcile-push]")?.disabled === false && document.querySelector(".push-panel [role=alert]") !== null');
        const pushReload = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve())); window.webContents.reload(); await pushReload; await wait('document.querySelector("[data-action=new-session]")?.disabled === false'); await wait(`document.querySelector('[data-task="${first.task.id}"] [data-action="open-task"]') !== null`); await click(`[data-task="${first.task.id}"] [data-action="open-task"]`); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(first.projectKey)} && document.querySelector("[data-action=reconcile-push]")?.disabled === false`); await click('.git-panel summary'); await click('.push-panel summary'); await click('[data-action="reconcile-push"]'); await wait('document.body.innerText.includes("Push confirmed:")');

        await click('.pr-panel summary');await wait('document.querySelector("[data-action=pr-targets]").disabled === false');await click('[data-action="pr-targets"]');await wait(`document.querySelector('[data-field="pr-remote"] option[value="origin"]') !== null`);
        await js(`{const field=document.querySelector('[data-field="pr-remote"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(field,"origin");field.dispatchEvent(new Event("change",{bubbles:true}));}`);
        await js(`{const field=document.querySelector('[data-field="pr-title"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,"PR reviewed in desktop");field.dispatchEvent(new Event("input",{bubbles:true}));}`);
        await js(`{const field=document.querySelector('[data-field="pr-body"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"Literal description <img onerror=alert(1)>");field.dispatchEvent(new Event("input",{bubbles:true}));}`);
        await wait('document.querySelector("[data-action=review-pr]").disabled === false');await click('[data-action="review-pr"]');await wait('document.querySelector("[data-action=create-pr]")?.disabled === false');await click('[aria-label="PR review"] > details > summary');await click('[aria-label="PR review"] details details summary');assert(await js(`document.querySelector('[aria-label="PR review"]').innerText.includes("task one only")`));assert.equal(await js('document.querySelectorAll(".pr-panel img").length'),0);
        await click('[data-action="create-pr"]');await wait('document.querySelector("[data-action=reconcile-pr]")?.disabled === false && document.querySelector(".pr-panel [role=alert]") !== null');
        const prReload=new Promise<void>(resolve=>window.webContents.once("did-finish-load",()=>resolve()));window.webContents.reload();await prReload;await wait('document.querySelector("[data-action=new-session]")?.disabled === false');await wait(`document.querySelector('[data-task="${first.task.id}"] [data-action="open-task"]') !== null`);await click(`[data-task="${first.task.id}"] [data-action="open-task"]`);await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(first.projectKey)} && document.querySelector("[data-action=reconcile-pr]")?.disabled === false`);await click('.git-panel summary');await click('.pr-panel summary');await click('[data-action="reconcile-pr"]');await wait('document.querySelector("[data-action=open-pr]")?.disabled === false');await openVerifiedPr();
        await writeFile(file, JSON.stringify(saved));
    } else {
        saved = JSON.parse(await readFile(file, "utf8"));
        const tasks = await js(`window.harness.tasks(${JSON.stringify(sourceKey)})`); assert.deepEqual(tasks, saved.map(item => item.task));
        for (const item of saved) {
            await wait(`document.querySelector('[data-task="${item.task.id}"] [data-action="open-task"]')?.disabled === false`); await click(`[data-task="${item.task.id}"] [data-action="open-task"]`); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(item.projectKey)} && document.querySelector("[data-session]")?.disabled === false`);
            const runtime = await runtimes.get(item.projectKey)!; workers.push(runtime); const session = await runtime.command({ method: "session.get", sessionId: item.sessionId }); assert(session.ok && session.data.kind === "session"); assert.deepEqual(session.data.session.runs.map(run => [run.runId, run.status]), [[item.runId, "cancelled"]]);
        }
        await click(`[data-task="${saved[0]!.task.id}"] [data-action="review-task-removal"]`); await wait('document.querySelector("[data-action=confirm-task-removal]") !== null'); assert(await js('document.querySelector("[data-action=confirm-task-removal]").disabled'));
        await click(`[data-task="${saved[1]!.task.id}"] [data-action="review-task-removal"]`); await wait('document.querySelector("[data-action=confirm-task-removal]")?.disabled === false'); await click('[data-action="confirm-task-removal"]'); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(sourceKey)}`);
        const removed: DesktopTask[] = await js(`window.harness.tasks(${JSON.stringify(sourceKey)})`); assert.equal(removed.find(task => task.id === saved[1]!.task.id)?.status, "removed");
        await access(saved[1]!.task.workspace).then(() => assert.fail("Checkout still exists"), () => { }); await access(path.join(path.dirname(saved[1]!.task.workspace), "state", "operations.sqlite"));
        assert.equal(await readFile(path.join(saved[0]!.task.workspace, "review.txt"), "utf8"), "task one only\n");
    }

    if(phase==="tasks-reopen"){
      const item=saved[0]!;await click(`[data-task="${item.task.id}"] [data-action="open-task"]`);await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(item.projectKey)} && document.querySelector("[data-action=restore-pr]")?.disabled === false`);await click('.git-panel summary');await click('.pr-panel summary');await click('[data-action="restore-pr"]');await wait('document.querySelector("[data-action=open-pr]")?.disabled === false');await openVerifiedPr();
    }
    await writeFile(path.join(directory, `${phase}-report.json`), JSON.stringify({ phase, packaged: app.isPackaged, appPid: process.pid, runtimePids: workers.map(worker => worker.context.runtimePid), tasks: saved.map(item => item.task.id), concurrentRuns: phase === "tasks-create", restartIsolation: phase === "tasks-reopen", reviewedCleanup: phase === "tasks-reopen", prUI:phase==="tasks-create",prResponseLossRecovered:phase==="tasks-create",prRecoveredAfterAppRestart:phase==="tasks-reopen",pushUI:phase=== "tasks-create", lostPushResponseReconciledAfterReload: phase === "tasks-create", gitCommitUI: phase === "tasks-create", lostCommitResponseReconciledAfterReload: phase === "tasks-create", runtimeGitMutationBlocked: phase === "tasks-create", fixture: true })); window.close();
}
