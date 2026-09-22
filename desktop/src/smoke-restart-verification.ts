import { app, type BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectRuntime } from "./runtime-host.js";
import type { HarnessClientRun } from "../../src/internal/desktop/protocol.js";

interface RestartCheckpoint {
    projectKey: string; sessionId: string; runId: string; revision: number; ticketId: string;
    approvals: HarnessClientRun["approvals"]; decisions?: HarnessClientRun["decisions"];
}

/** Host-only, offline fixture. Each phase runs in a fresh application process. */
export async function verifyDesktopRestartSmoke(window: BrowserWindow, runtimes: Map<string, Promise<ProjectRuntime>>, directory: string, phase: string, cliPath: string | undefined) {
    assert(["prepare", "approve", "history", "active-close", "cancelled-history"].includes(phase));
    assert(cliPath && path.isAbsolute(cliPath));
    const js = (source: string) => window.webContents.executeJavaScript(source);
    const wait = async (source: string) => { for (let i = 0; i < 200; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 50)); } await writeFile(path.join(directory, `${phase}-failure-view.txt`), await js("document.body.innerText")); throw new Error(`RESTART_SMOKE_TIMEOUT: ${source}`); };
    const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await wait('document.querySelector("[data-ready=true]") !== null');
    if (!["prepare", "active-close"].includes(phase)) {
        assert.equal(await js('document.querySelectorAll("[data-project]").length'), 1);
        await click('[data-project]');
    }
    await wait('document.querySelector("[data-action=new-session]")?.disabled === false');
    const projectKey: string = await js('document.querySelector("main").dataset.projectKey');
    const runtime = await runtimes.get(projectKey)!;
    const cli = async (args: string[]) => {
        const { stdout } = await promisify(execFile)(process.execPath, [cliPath, ...args, "--service", runtime.fixtureCredentialsPath(), "--json"], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10000, maxBuffer: 1024 * 1024 });
        return JSON.parse(stdout);
    };
    const file = path.join(runtime.context.project.workspace, "review.txt"), checkpointFile = path.join(directory, "restart-checkpoint.json");
    const before = "context\r\nbefore\r\nlast", after = "context\r\nafter <img onerror=alert(1)>\r\nlast";
    if (phase === "active-close") {
        await click('[data-action="new-session"]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)');
        const sessionId: string = await js('document.querySelector("main").dataset.sessionId');
        await click('[data-action="wait"]'); await wait('document.querySelector("[data-action=cancel]").disabled === false');
        const session = await runtime.command({ method: "session.get", sessionId }); assert(session.ok && session.data.kind === "session"); assert.equal(session.data.session.runs.length, 1); const runId = session.data.session.runs[0]!.runId;
        const running = await runtime.command({ method: "run.get", sessionId, runId }); assert(running.ok && running.data.kind === "run"); assert.equal(running.data.run.status, "running");
        window.close(); // First fixture choice is stay; preserve the visible window/run.
        await wait(`window.harness.command(${JSON.stringify(projectKey)},{method:"project.get"}).then(result=>result.ok,()=>false)`);
        assert(!window.isDestroyed()); assert(runtime.isAlive());
        const retained = await runtime.command({ method: "run.get", sessionId, runId }); assert(retained.ok && retained.data.kind === "run"); assert.equal(retained.data.run.status, "running");
        await writeFile(checkpointFile, JSON.stringify({ projectKey, sessionId, runId, revision: retained.data.run.revision, approvals: [], ticketId: "none" }));
        await writeFile(path.join(directory, `${phase}-report.json`), JSON.stringify({ schemaVersion: 1, phase, packaged: app.isPackaged, appPid: process.pid, runtimePid: runtime.context.runtimePid, sessionId, runId, windowCloseRequested: true, stayPreservedActiveRun: true, quitCancellationRequested: true, fixture: true }));
        app.quit(); // Second fixture choice cancels; also exercises menu/application quit.
        return;
    }
    if (phase === "cancelled-history") {
        const saved: RestartCheckpoint = JSON.parse(await readFile(checkpointFile, "utf8")); assert.equal(projectKey, saved.projectKey);
        await wait('document.querySelector("[data-session]")?.disabled === false'); await click(`[data-session="${saved.sessionId}"]`);
        await wait('document.body.innerText.includes("cancelled")');
        const session = await runtime.command({ method: "session.get", sessionId: saved.sessionId }); assert(session.ok && session.data.kind === "session"); assert.deepEqual(session.data.session.runs.map(run => run.runId), [saved.runId]); assert.equal(session.data.session.runs[0]!.status, "cancelled");
        const inspected = await cli(["sessions", "inspect", saved.sessionId]); assert.deepEqual(inspected.session, session.data.session);
        assert.equal(await readFile(file, "utf8"), before);
        await writeFile(path.join(directory, `${phase}-report.json`), JSON.stringify({ schemaVersion: 1, phase, packaged: app.isPackaged, appPid: process.pid, runtimePid: runtime.context.runtimePid, sessionId: saved.sessionId, runId: saved.runId, windowCloseRequested: true, cancelledRunRecovered: true, cliSessionMatched: true, noReplay: true, fixture: true }));
        window.close(); return;
    }
    let checkpoint: RestartCheckpoint;
    let rendererExitReason: string | undefined;
    if (phase === "prepare") {
        await click('[data-action="new-session"]'); await wait('Boolean(document.querySelector("main").dataset.sessionId)');
        const sessionId: string = await js('document.querySelector("main").dataset.sessionId');
        await js('{const input=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"file-review-probe");input.dispatchEvent(new Event("input",{bubbles:true}));}');
        await wait('document.querySelector("[data-action=start]").disabled === false'); await click('[data-action="start"]');
        await wait('document.querySelector("[data-action=review]") !== null');
        const session = await runtime.command({ method: "session.get", sessionId }); assert(session.ok && session.data.kind === "session"); assert.equal(session.data.session.runs.length, 1);
        const runId = session.data.session.runs[0]!.runId;
        const response = await runtime.command({ method: "run.get", sessionId, runId }); assert(response.ok && response.data.kind === "run"); assert.equal(response.data.run.status, "waiting_approval"); assert.equal(response.data.run.decisionTotal, 0);
        const gone = new Promise<Electron.RenderProcessGoneDetails>(resolve => window.webContents.once("render-process-gone", (_event, details) => resolve(details)));
        const loaded = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve()));
        window.webContents.forcefullyCrashRenderer(); rendererExitReason = (await gone).reason; assert(["crashed", "killed"].includes(rendererExitReason));
        await loaded;
        await wait('document.querySelector("[data-ready=true]") && document.querySelector("[data-session]")?.disabled === false');
        await click(`[data-session="${sessionId}"]`); await wait('document.querySelector("[data-action=review]") !== null');
        const rendererRecovered = await runtime.command({ method: "run.get", sessionId, runId }); assert(rendererRecovered.ok && rendererRecovered.data.kind === "run"); assert.deepEqual(rendererRecovered.data.run, response.data.run);
        await click('[data-action="review"]'); await wait('document.querySelector("[data-action=approve-review]")?.disabled === false');
        assert.equal(await readFile(file, "utf8"), before);
        const ticket = await runtime.review(sessionId, runId);
        checkpoint = { projectKey, sessionId, runId, revision: response.data.run.revision, approvals: response.data.run.approvals, ticketId: ticket.ticketId };
    } else {
        checkpoint = JSON.parse(await readFile(checkpointFile, "utf8")); assert.equal(projectKey, checkpoint.projectKey);
        const { sessionId, runId } = checkpoint;
        await wait('document.querySelector("[data-session]")?.disabled === false');
        assert.equal(await js('document.querySelectorAll("[data-session]").length'), 1);
        await click(`[data-session="${sessionId}"]`);
        const session = await runtime.command({ method: "session.get", sessionId }); assert(session.ok && session.data.kind === "session"); assert.deepEqual(session.data.session.runs.map(run => run.runId), [runId]);
        const inspected = await cli(["sessions", "inspect", sessionId]); assert.equal(inspected.kind, "session"); assert.deepEqual(inspected.session, session.data.session);
        const response = await runtime.command({ method: "run.get", sessionId, runId }); assert(response.ok && response.data.kind === "run");
        if (phase === "approve") {
            assert.equal(response.data.run.status, "waiting_approval"); assert.equal(response.data.run.revision, checkpoint.revision); assert.equal(response.data.run.decisionTotal, 0); assert.deepEqual(response.data.run.approvals, checkpoint.approvals);
            assert.equal(await readFile(file, "utf8"), before);
            // A review receipt from the terminated main process must never authorize work.
            assert(await js(`window.harness.resolveReview(${JSON.stringify(projectKey)},${JSON.stringify(checkpoint.ticketId)},true).then(()=>false,error=>String(error).includes("REVIEW_REQUIRED"))`));
            assert.equal(await readFile(file, "utf8"), before);
            await wait('document.querySelector("[data-action=review]") !== null'); await click('[data-action="review"]');
            await wait('document.querySelector("[data-action=approve-review]")?.disabled === false');
            assert.equal(await js('document.querySelector(".review-file .removed").textContent'), before);
            assert.equal(await js('document.querySelector(".review-file .added").textContent'), after);
            await click('[data-action="approve-review"]'); await wait('document.querySelector("[data-action=review]") === null && document.body.innerText.includes("completed")');
            const completed = await runtime.command({ method: "run.get", sessionId, runId }); assert(completed.ok && completed.data.kind === "run"); assert.equal(completed.data.run.status, "completed"); assert.equal(completed.data.run.decisionTotal, 1); assert.equal(completed.data.run.decisions?.[0]?.status, "applied");
            checkpoint.decisions = completed.data.run.decisions; assert.equal(await readFile(file, "utf8"), after);
        } else {
            assert.equal(response.data.run.status, "completed"); assert.deepEqual(response.data.run.decisions, checkpoint.decisions); assert.equal(response.data.run.decisionTotal, 1); assert.equal(await readFile(file, "utf8"), after);
            await wait(`document.querySelector('[data-run="${runId}"] [data-action="decision-history"]') !== null`);
            await click(`[data-run="${runId}"] [data-action="decision-history"]`); await wait('document.querySelector("[data-decision-status=applied]") !== null');
            assert.equal(await js('document.querySelectorAll("[data-decision-status=applied]").length'), 1);
            const title = "HU30 validada desde CLI";
            const renamed = await cli(["sessions", "rename", sessionId, title]); assert.equal(renamed.session.title, title);
            await click(`[data-session="${sessionId}"]`); await wait(`document.querySelector('[data-session="${sessionId}"]').innerText.includes(${JSON.stringify(title)})`);
            const listed = await cli(["sessions", "list"]); assert.equal(listed.sessions.length, 1); assert.deepEqual(listed.sessions[0], renamed.session);
            // Later repository edits must not become the final diff of the earlier run.
            await writeFile(file, "unrelated later edit\n");
            await click(`[data-run="${runId}"] [data-action="decision-history"]`); await wait('document.querySelector(".final-diff") !== null');
            await click('.final-diff summary'); assert.equal(await js('document.querySelector(".final-diff .removed").textContent'), before); assert.equal(await js('document.querySelector(".final-diff .added").textContent'), after);
            assert.equal(await js('document.querySelectorAll(".final-diff img").length'), 0); assert.equal(await readFile(file, "utf8"), "unrelated later edit\n");
            await writeFile(path.join(directory, "restart-history.png"), (await window.webContents.capturePage()).toPNG());
        }
    }
    await writeFile(checkpointFile, JSON.stringify(checkpoint, null, 2));
    await writeFile(path.join(directory, `${phase}-report.json`), JSON.stringify({ schemaVersion: 1, phase, packaged: app.isPackaged, appPid: process.pid, runtimePid: runtime.context.runtimePid, sessionId: checkpoint.sessionId, runId: checkpoint.runId, rendererCrashRecovered: phase === "prepare", rendererExitReason, cliSessionMatched: phase !== "prepare", cliRenameVisible: phase === "history", persistedFinalDiff: phase === "history", laterChangesExcluded: phase === "history", windowCloseRequested: true, fixture: true }, null, 2));
    // Exercise the user's window-close path, including main's service-drain handler.
    window.close();
}
