import { app, type BrowserWindow } from "electron";
import { stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import type { ProjectRuntime } from "./runtime-host.js";
export async function verifyDesktopSmoke(window: BrowserWindow, runtimes: Map<string, Promise<ProjectRuntime>>, reportDirectory: string) {
    const js = async (source: string) => { try { return await window.webContents.executeJavaScript(source); } catch (error) { await writeFile(path.join(reportDirectory, "failure-script.txt"), source); await writeFile(path.join(reportDirectory, "failure-view.txt"), await window.webContents.executeJavaScript("document.body.innerText")); throw error; } };
    const wait = async (expression: string) => { for (let i = 0; i < 200; i++) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 50)); } await writeFile(path.join(reportDirectory, "failure-view.txt"), await js("document.body.innerText")); throw new Error(`RENDERER_TIMEOUT: ${expression}`); };
    const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await wait('document.querySelector("[data-ready=true]") !== null');
    const isolated = await js('typeof require === "undefined" && typeof process === "undefined" && Object.keys(window.harness).sort().join(",") === "checkUpdates,chooseProject,command,configureCredential,createPr,createTask,credentialStatus,deleteCredential,downloadUpdate,events,gitChanges,gitCommit,gitReconcile,gitReviewCommit,gitStage,initialProject,installUpdate,openPr,openProject,openTask,probeCredential,projects,providers,push,reconcilePr,reconcilePush,remoteTargets,removeTask,resolveReview,review,reviewPr,reviewPush,reviewTaskRemoval,selectModel,tasks,updateStatus"'); assert(isolated);
    const updateStatus = await js('window.harness.updateStatus()');
    if (updateStatus.status === "unconfigured") {assert.deepEqual(await js('window.harness.checkUpdates()'), {status: "unconfigured"}); await wait('document.querySelector("[data-action=check-updates]")?.disabled === true');}
    const emptyStartup = !(await js('window.harness.projects()')).length;
    if (emptyStartup) { assert(await js('document.body.innerText.includes("Open a repository")')); await click('[data-action="open-project"]'); await wait('Boolean(document.querySelector("main").dataset.projectKey) && document.querySelector("[data-action=new-session]").disabled === false'); }
    const projects = await js('window.harness.projects()'); assert.equal(projects.length, 1); const firstKey = projects[0].key;
    let first = await runtimes.get(firstKey)!; assert(first.context.runtimePid !== process.pid);
    const duplicate = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), "--smoke-test", "--report-directory", reportDirectory], { stdio: "ignore" });
    const duplicateTimer = setTimeout(() => duplicate.kill("SIGKILL"), 10000);
    try { assert.equal(await new Promise<number | null>((resolve, reject) => { duplicate.once("exit", resolve); duplicate.once("error", reject); }), 0); } finally { clearTimeout(duplicateTimer); }

    const rejectedOverrides = await js(`Promise.all([
 window.harness.command(${JSON.stringify(firstKey)},{method:"project.get",projectId:"forged"}).then(()=>false,()=>true),
 window.harness.command(${JSON.stringify(firstKey)},{method:"project.get",workspace:"/"}).then(()=>false,()=>true),
 window.harness.openProject("/arbitrary/path").then(()=>false,()=>true)
 ]).then(r=>r.every(Boolean))`); assert(rejectedOverrides);
    const listFirst = await first.command({ method: "session.list" }); assert(listFirst.ok && listFirst.data.kind === "sessions"); assert.equal(listFirst.data.sessions.length, 0);
    await click('[data-action="new-session"]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)');
    const sessionId = await js('document.querySelector("main").dataset.sessionId');
    await js(`const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"Describe the local runtime connection.");field.dispatchEvent(new Event("input",{bubbles:true}));`);
    await wait('document.querySelector("[data-action=start]").disabled === false'); await click('[data-action="start"]'); await wait('document.body.innerText.includes("completed")');
    await wait('document.querySelector("[data-action=wait]").disabled === false'); await click('[data-action="wait"]'); await wait('document.querySelector("[data-action=cancel]").disabled === false'); await click('[data-action="cancel"]'); await wait('document.body.innerText.includes("cancelled")');
    const before = await first.command({ method: "session.get", sessionId }); assert(before.ok && before.data.kind === "session"); const runIds = before.data.session.runs.map(r => r.runId);
    await click('[data-action="open-project"]'); await wait('document.querySelector("[role=alert]") !== null && document.querySelector("[data-action=open-project]").disabled === false'); assert.equal(await js('document.querySelector("main").dataset.projectKey'), firstKey);
    await click('[data-action="open-project"]'); await wait(`document.querySelector("main").dataset.projectKey !== ${JSON.stringify(firstKey)} && Boolean(document.querySelector("main").dataset.projectKey)`);
    const secondKey = await js('document.querySelector("main").dataset.projectKey'); const second = await runtimes.get(secondKey)!;
    await wait('document.querySelectorAll("[data-session]").length === 0'); assert.equal(await js('document.querySelector("[data-action=start]").disabled'), true);
    const foreign = await second.command({ method: "session.get", sessionId }); assert(!foreign.ok); assert.equal(foreign.error.code, "NOT_FOUND");
    await click('[data-action="new-session"]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)'); const secondSession = await js('document.querySelector("main").dataset.sessionId'); assert.notEqual(secondSession, sessionId);
    await click(`[data-project="${firstKey}"]`); await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(firstKey)} && document.querySelectorAll("[data-session]").length === 1`);
    // Arrow navigation changes focus only; activation via Enter selects the conversation.
    await wait('document.querySelector("[data-session]").disabled === false'); window.focus(); window.webContents.focus(); await js('document.querySelector("[data-session]").focus()'); window.webContents.sendInputEvent({ type: "keyDown", keyCode: "ArrowDown" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "ArrowDown" });
    assert.equal(await js('document.activeElement.dataset.session'), sessionId);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" }); window.webContents.sendInputEvent({ type: "char", keyCode: "\r" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await wait(`document.querySelector("main").dataset.sessionId === ${JSON.stringify(sessionId)} && document.body.innerText.includes("cancelled") && document.body.innerText.includes("Separate runtime")`);
    const after = await first.command({ method: "session.get", sessionId }); assert(after.ok && after.data.kind === "session"); assert.deepEqual(after.data.session.runs.map(r => r.runId), runIds);
    const other = await second.command({ method: "session.get", sessionId: secondSession }); assert(other.ok && other.data.kind === "session"); assert.equal(other.data.session.runs.length, 0);
    const loaded = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve())); window.webContents.reload(); await loaded; await wait('document.querySelector("[data-ready=true]") !== null'); assert.equal((await js('window.harness.projects()')).length, 2);
    if (emptyStartup) { await click(`[data-project="${firstKey}"]`); }
    await wait('document.querySelectorAll("[data-session]").length === 1 && document.querySelector("[data-session]").disabled === false'); await click(`[data-session="${sessionId}"]`); await wait('document.body.innerText.includes("cancelled") && document.body.innerText.includes("Separate runtime")');
    // HU28: duplicate submit, actual read/check tools, failed receipt, redaction and reconnect.
    await js(`const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"activity-probe");field.dispatchEvent(new Event("input",{bubbles:true}));`);
    await wait('document.querySelector("[data-action=start]").disabled === false');
    await js('for(let i=0;i<2;i++)document.querySelector("#prompt").closest("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
    await wait('document.body.innerText.includes("waiting_approval") && document.querySelector("[data-action=wait]").disabled === false');
    const pendingSession = await first.command({ method: "session.get", sessionId }); assert(pendingSession.ok && pendingSession.data.kind === "session"); assert.equal(pendingSession.data.session.runs.length, runIds.length + 1);
    const probeId = pendingSession.data.session.runs.at(-1)!.runId;
    const pending = await first.command({ method: "run.get", sessionId, runId: probeId }); assert(pending.ok && pending.data.kind === "run"); assert.equal(pending.data.run.status, "waiting_approval");
    await click('[data-action="review"]'); await wait('document.querySelector("[data-review-item]") !== null');
    assert(await js('document.querySelector("[data-review-item]").innerText.includes("bun -e")'));
    await first.setFixtureApprovalClock(3600000);
    await click('[data-action="approve-review"]'); await wait('document.querySelector(".review-panel [role=alert]")?.textContent.includes("expired")');
    const expiredDecision = await first.command({ method: "run.get", sessionId, runId: probeId }); assert(expiredDecision.ok && expiredDecision.data.kind === "run"); assert.equal(expiredDecision.data.run.status, "waiting_approval"); assert.equal(expiredDecision.data.run.decisions?.length, 0);
    await first.setFixtureApprovalClock(0); await click('[data-action="review"]'); await wait('document.querySelector("[data-review-item]") !== null');
    const staleReview = await first.review(sessionId, probeId);
    const reviewed = await first.review(sessionId, probeId); assert.equal(reviewed.revision, pending.data.run.revision); assert.equal(reviewed.items[0]?.digest, pending.data.run.approvals[0]?.digest);
    assert(await js(`window.harness.command(${JSON.stringify(firstKey)},{method:"approval.resolve"}).then(()=>false,()=>true)`));
    const resumed = first.resolveReview(reviewed.ticketId, true);
    first.setFixtureOffline(true);
    await wait('document.body.innerText.includes("Connection interrupted")');
    first.setFixtureOffline(false);
    const reloadActive = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve())); window.webContents.reload(); await reloadActive; await wait('document.querySelector("[data-ready=true]") !== null');
    if (emptyStartup) await click(`[data-project="${firstKey}"]`);
    await wait('document.querySelector("[data-session]")?.disabled === false'); await click(`[data-session="${sessionId}"]`);
    const finished = await resumed; assert(finished.ok && finished.data.kind === "run"); assert.equal(finished.data.run.status, "completed");
    const staleDecision = await js(`window.harness.resolveReview(${JSON.stringify(firstKey)},${JSON.stringify(staleReview.ticketId)},true)`); assert.equal(staleDecision.ok, false); assert.equal(staleDecision.error.code, "REVISION_CONFLICT"); assert.equal(finished.data.run.decisionTotal, 1);
    await wait(`document.querySelector('[data-run="${probeId}"] [data-tool="run_check"][data-tool-status="failed"]') !== null && document.body.innerText.includes("part-39")`);
    assert(await js('document.body.innerText.includes("exit 7") && document.body.innerText.includes("<img src=x onerror=alert(1)>") && !document.querySelector(".timeline img")'));
    const secret = process.env.ZHIVEX_HARNESS_DESKTOP_FIXTURE_SECRET!;
    assert(!(await js('document.body.innerText')).includes(secret));
    const boundary = await js(`window.harness.command(${JSON.stringify(firstKey)},{method:"run.get",sessionId:${JSON.stringify(sessionId)},runId:${JSON.stringify(probeId)}})`);
    assert(!JSON.stringify(boundary).includes(secret)); assert(!JSON.stringify(boundary).includes("cliResult"));
    const expired = await first.events({ sessionId, after: 0 }); assert(expired.cursorExpired); assert(expired.snapshot?.runs[probeId]?.prompt === "activity-probe"); assert.equal(expired.snapshot?.runs[probeId]?.tools?.["tool:probe-check"]?.exitCode, 7);
    const finalSession = await first.command({ method: "session.get", sessionId }); assert(finalSession.ok && finalSession.data.kind === "session"); assert.equal(finalSession.data.session.runs.length, runIds.length + 1);
    await js(`document.querySelector('[data-run="${probeId}"] [data-tool="run_check"]').scrollIntoView({block:"center"})`);
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(path.join(reportDirectory, "screenshot-chat.png"), (await window.webContents.capturePage()).toPNG());
    first.dropFixtureRunResponse();
    await js(`const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"response-loss-probe");field.dispatchEvent(new Event("input",{bubbles:true}));`);
    await wait('document.querySelector("[data-action=start]").disabled === false'); await click('[data-action="start"]');
    await wait('document.body.innerText.includes("Could not complete the operation.")'); assert(await js('document.querySelector("[data-action=start]").disabled'));
    const lost = await first.command({ method: "session.get", sessionId }); assert(lost.ok && lost.data.kind === "session"); assert.equal(lost.data.session.runs.length, runIds.length + 2);
    await click('[data-action="retry"]'); await wait('document.querySelector("#prompt").disabled === false && document.body.innerText.includes("response-loss-probe") && !document.body.innerText.includes("Could not complete the operation.")');
    const reconciled = await first.command({ method: "session.get", sessionId }); assert(reconciled.ok && reconciled.data.kind === "session"); assert.deepEqual(reconciled.data.session.runs, lost.data.session.runs);
    assert.equal(await js(`document.querySelector('[data-session="${sessionId}"] small').textContent`), "completed");
    // HU30: kill a worker while it owns an active run. Reopening only reads it;
    // cancellation is explicit and must wait for the dead worker's lease to expire.
    await wait('document.querySelector("[data-action=wait]").disabled === false'); await click('[data-action="wait"]');
    await wait('document.querySelector("[data-action=cancel]").disabled === false');
    const activeSession = await first.command({ method: "session.get", sessionId }); assert(activeSession.ok && activeSession.data.kind === "session");
    const interruptedId = activeSession.data.session.runs.at(-1)!.runId;
    const interrupted = await first.command({ method: "run.get", sessionId, runId: interruptedId }); assert(interrupted.ok && interrupted.data.kind === "run"); assert.equal(interrupted.data.run.status, "running");
    await first.crashFixture(); await wait('document.body.innerText.includes("Connection interrupted")');
    await click('[data-action="reconnect-project"]'); await wait('document.querySelector("[data-session]")?.disabled === false'); first = await runtimes.get(firstKey)!;
    await click(`[data-session="${sessionId}"]`); await wait('document.querySelector("[data-action=cancel]")?.disabled === false');
    await click('[data-action="cancel"]'); await wait('document.body.innerText.includes("active lease")');
    const stillInterrupted = await first.command({ method: "run.get", sessionId, runId: interruptedId }); assert(stillInterrupted.ok && stillInterrupted.data.kind === "run"); assert.equal(stillInterrupted.data.run.revision, interrupted.data.run.revision);
    await new Promise(resolve => setTimeout(resolve, 31000));
    await click('[data-action="retry"]'); await wait('document.querySelector("[data-action=cancel]")?.disabled === false'); await click('[data-action="cancel"]');
    await wait(`document.querySelector('[data-run="${interruptedId}"]').innerText.includes("cancelled") && document.querySelector("[data-action=wait]").disabled === false`);
    const cancelledOrphan = await first.command({ method: "run.get", sessionId, runId: interruptedId }); assert(cancelledOrphan.ok && cancelledOrphan.data.kind === "run"); assert.equal(cancelledOrphan.data.run.status, "cancelled");
    const recoveredSession = await first.command({ method: "session.get", sessionId }); assert(recoveredSession.ok && recoveredSession.data.kind === "session"); assert.equal(recoveredSession.data.session.runs.length, activeSession.data.session.runs.length);
    const decisionRuns: Array<{ runId: string; status: string }> = [];
    for (const approve of [false, true]) {
        await js(`{const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"file-review-probe");field.dispatchEvent(new Event("input",{bubbles:true}));}`);
        await wait('document.querySelector("[data-action=start]").disabled === false'); await click('[data-action="start"]');
        await wait('document.querySelector("[data-action=review]") !== null');
        if (!approve) {
            const prior = await first.command({ method: "session.get", sessionId }); assert(prior.ok && prior.data.kind === "session"); const pendingId = prior.data.session.runs.at(-1)!.runId;
            const previousPid = first.context.runtimePid; await first.crashFixture(); await wait('document.body.innerText.includes("Connection interrupted")');
            await click('[data-action="reconnect-project"]'); await wait('document.querySelector("[data-session]")?.disabled === false'); first = await runtimes.get(firstKey)!; assert.notEqual(first.context.runtimePid, previousPid);
            await click(`[data-session="${sessionId}"]`); await wait('document.querySelector("[data-action=review]") !== null');
            const recovered = await first.command({ method: "run.get", sessionId, runId: pendingId }); assert(recovered.ok && recovered.data.kind === "run"); assert.equal(recovered.data.run.status, "waiting_approval"); assert.equal(recovered.data.run.decisionTotal, 0);
        }
        await click('[data-action="review"]');
        await wait('document.querySelector("[data-action=approve-review]")?.disabled === false');
        assert.equal(await js('document.querySelector(".review-file .removed").textContent'), "context\r\nbefore\r\nlast");
        assert(await js('document.querySelector(".review-file .added").textContent.includes("after <img onerror=alert(1)>") && !document.querySelector(".review-file img")'));
        assert.equal(await readFile(path.join(first.context.project.workspace, "review.txt"), "utf8"), "context\r\nbefore\r\nlast");
        if (approve) { await js('document.querySelector(".review-file").scrollIntoView({block:"center"})'); await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); await writeFile(path.join(reportDirectory, "screenshot-review.png"), (await window.webContents.capturePage()).toPNG()); }
        await click(approve ? '[data-action="approve-review"]' : '[data-action="deny-review"]');
        await wait('document.querySelector("[data-action=review]") === null && document.querySelector("#prompt").disabled === false');
        assert.equal(await readFile(path.join(first.context.project.workspace, "review.txt"), "utf8"), approve ? "context\r\nafter <img onerror=alert(1)>\r\nlast" : "context\r\nbefore\r\nlast");
        const latest = await first.command({ method: "session.get", sessionId }); assert(latest.ok && latest.data.kind === "session"); decisionRuns.push({ runId: latest.data.session.runs.at(-1)!.runId, status: approve ? "applied" : "rejected" });
    }
    const reloadedHistory = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve())); window.webContents.reload(); await reloadedHistory; await wait('document.querySelector("[data-ready=true]") !== null');
    if (emptyStartup) await click(`[data-project="${firstKey}"]`);
    await wait('document.querySelector("[data-session]")?.disabled === false'); await click(`[data-session="${sessionId}"]`);
    for (const item of [...decisionRuns, { runId: probeId, status: "failed" }]) {
        await wait(`document.querySelector('[data-run="${item.runId}"] [data-action="decision-history"]') !== null`);
        await click(`[data-run="${item.runId}"] [data-action="decision-history"]`);
        await wait(`document.querySelector('[data-run="${item.runId}"] [data-decision-status="${item.status}"]') !== null`);
    }
    await js(`document.querySelector('[data-run="${decisionRuns[1]!.runId}"] .decision-history').scrollIntoView({block:"center"})`);
    await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await writeFile(path.join(reportDirectory, "screenshot-decisions.png"), (await window.webContents.capturePage()).toPNG());
    const database = await stat(path.join(first.stateDirectory, "operations.sqlite"));
    await writeFile(path.join(reportDirectory, "screenshot.png"), (await window.webContents.capturePage()).toPNG());
    await writeFile(path.join(reportDirectory, "report.json"), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch, electron: process.versions.electron, hostNode: process.versions.node, runtimeNode: first.context.runtimeNode, separateProcess: true, isolatedRenderer: isolated, rejectedOverrides, sqliteBytes: database.size, streaming: true, cancellation: true, fileApprovalUI: true, fileRejectionUI: true, completePreimage: true, decisionHistoryReload: true, serviceCrashRecovered: true, activeCrashRecovered: true, liveLeaseCancellationRejected: true, orphanCancelledWithoutReplay: true, expiredApprovalRejected: true, staleApprovalRejected: true, duplicateSubmitPrevented: true, lostResponseReconciled: true, failedCheckVisible: true, redactedRenderer: true, literalRepositoryText: true, activeReconnect: true, expiredSnapshot: true, projectIsolation: true, singleInstance: true, emptyStartup, invalidProjectRecovery: true, selectionHasNoExecution: true, keyboardNavigation: true, rendererReload: true, recentProjects: 2, packaged: app.isPackaged, fixture: true }, null, 2));
}
