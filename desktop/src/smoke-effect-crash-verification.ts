import { app, type BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {readRegularFileNoFollow} from "../../src/internal/desktop/persistence.js";
import assert from "node:assert/strict";
import type { ProjectRuntime } from "./runtime-host.js";

export async function verifyDesktopEffectCrashSmoke(window: BrowserWindow, runtimes: Map<string, Promise<ProjectRuntime>>, directory: string, phase: string) {
    assert(["effect-crash", "effect-recovery"].includes(phase));
    const js = async (source: string) => { try { return await window.webContents.executeJavaScript(source); } catch (error) { await writeFile(path.join(directory, `${phase}-failure-script.txt`), source); await writeFile(path.join(directory, `${phase}-failure-view.txt`), await window.webContents.executeJavaScript("document.body.innerText")); throw error; } };
    const wait = async (source: string) => { for (let i = 0; i < 200; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); } await writeFile(path.join(directory, `${phase}-failure-view.txt`), await js("document.body.innerText")); throw new Error(`EFFECT_CRASH_TIMEOUT: ${source}`); };
    const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await wait('document.querySelector("[data-ready=true]") !== null');
    if (phase === "effect-recovery") await click('[data-project]');
    await wait('document.querySelector("[data-action=new-session]")?.disabled === false');
    const projectKey: string = await js('document.querySelector("main").dataset.projectKey'), runtime = await runtimes.get(projectKey)!;
    const file = path.join(runtime.context.project.workspace, "review.txt"), checkpoint = path.join(directory, "effect-checkpoint.json"), after = "context\r\nafter <img onerror=alert(1)>\r\nlast";
    let sessionId: string, runId: string;
    if (phase === "effect-crash") {
        await click('[data-action="new-session"]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)'); sessionId = await js('document.querySelector("main").dataset.sessionId');
        await js('{const input=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"file-review-probe");input.dispatchEvent(new Event("input",{bubbles:true}));}');
        await wait('document.querySelector("[data-action=start]").disabled === false'); await click('[data-action="start"]'); await wait('document.querySelector("[data-action=review]") !== null');
        const session = await runtime.command({ method: "session.get", sessionId }); assert(session.ok && session.data.kind === "session"); assert.equal(session.data.session.runs.length, 1); runId = session.data.session.runs[0]!.runId;
        const pending = await runtime.command({ method: "run.get", sessionId, runId }); assert(pending.ok && pending.data.kind === "run"); const decisions = pending.data.run.approvals.map(a => ({ approvalId: a.approvalId, digest: a.digest, approve: true })); assert.equal(decisions.length, 1);
        await click('[data-action="review"]'); await wait('document.querySelector("[data-action=approve-review]")?.disabled === false'); await click('[data-action="approve-review"]');
        await wait('document.body.innerText.includes("Connection interrupted")'); assert(!runtime.isAlive());
        const marker = JSON.parse(await readFile(path.join(directory, "socket/effect-crash.json"), "utf8")); assert.equal(marker.runId, runId); assert.equal(marker.pid, runtime.context.runtimePid); assert(marker.beforeJournalCommit);
        const effect = await readRegularFileNoFollow(file, {label: "crash fixture effect", maxBytes: 4096});
        assert.equal(effect.contents.toString("utf8"), after);
        await writeFile(checkpoint, JSON.stringify({ projectKey, sessionId, runId, decisions, mtime: effect.stat.mtimeMs }));
    } else {
        const saved = JSON.parse(await readFile(checkpoint, "utf8")); ({ sessionId, runId } = saved); assert.equal(projectKey, saved.projectKey);
        await wait('document.querySelector("[data-session]")?.disabled === false'); await click(`[data-session="${sessionId}"]`);
        const recovered = await runtime.command({ method: "run.get", sessionId, runId, includeDiff: true }); assert(recovered.ok && recovered.data.kind === "run"); assert.equal(recovered.data.run.decisionTotal, 1); assert.equal(recovered.data.run.decisions?.[0]?.status, "unknown"); assert.equal(recovered.data.run.decisions?.[0]?.finalDiff, undefined);
        { const effect = await readRegularFileNoFollow(file, {label: "recovered fixture effect", maxBytes: 4096}); assert.equal(effect.contents.toString("utf8"), after); assert.equal(effect.stat.mtimeMs, saved.mtime); }
        await wait(`document.querySelector('[data-run="${runId}"] [data-action="decision-history"]') !== null`); await click(`[data-run="${runId}"] [data-action="decision-history"]`); await wait('document.querySelector("[data-decision-status=unknown]") !== null'); assert.equal(await js('document.querySelectorAll(".final-diff").length'), 0);
        assert.equal(recovered.data.run.status, "running");
        const duplicate = await runtime.command({ method: "approval.resolve", sessionId, runId, expectedRevision: recovered.data.run.revision, idempotencyKey: "effect-retry", decisions: saved.decisions }); assert(!duplicate.ok); assert.equal(duplicate.error.code, "INVALID_STATE");
        await wait('document.querySelector("[data-action=cancel]").disabled === false'); await click('[data-action="cancel"]'); await wait('document.body.innerText.includes("active lease")');
        await new Promise(resolve => setTimeout(resolve, 31000));
        await click('[data-action="retry"]'); await wait('document.querySelector("[data-action=cancel]").disabled === false'); await click('[data-action="cancel"]'); await wait(`document.querySelector('[data-run="${runId}"]').innerText.includes("cancelled")`);
        await js('{const input=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"Summarize after interruption without editing");input.dispatchEvent(new Event("input",{bubbles:true}));}');
        await wait('document.querySelector("[data-action=start]").disabled === false'); await click('[data-action="start"]'); await wait('document.body.innerText.includes("completed")');
        const latest = await runtime.command({ method: "session.get", sessionId }); assert(latest.ok && latest.data.kind === "session"); assert.equal(latest.data.session.runs.length, 2); assert.equal(latest.data.session.runs[0]!.runId, runId);
        const old = await runtime.command({ method: "run.get", sessionId, runId, includeDiff: true }); assert(old.ok && old.data.kind === "run"); assert.equal(old.data.run.decisionTotal, 1); assert.equal(old.data.run.decisions?.[0]?.status, "unknown"); assert.equal(old.data.run.decisions?.[0]?.finalDiff, undefined);
        { const effect = await readRegularFileNoFollow(file, {label: "recovered fixture effect", maxBytes: 4096}); assert.equal(effect.contents.toString("utf8"), after); assert.equal(effect.stat.mtimeMs, saved.mtime); }
    }
    await writeFile(path.join(directory, `${phase}-report.json`), JSON.stringify({ schemaVersion: 1, phase, packaged: app.isPackaged, appPid: process.pid, runtimePid: runtime.context.runtimePid, sessionId, runId, windowCloseRequested: true, effectBeforeJournalCrash: phase === "effect-crash", outcomeUnknown: phase === "effect-recovery", noAppliedDiff: phase === "effect-recovery", duplicateApprovalRejected: phase === "effect-recovery", explicitCancellation: phase === "effect-recovery", continuedWithoutReplay: phase === "effect-recovery", fixture: true }, null, 2));
    window.close();
}
