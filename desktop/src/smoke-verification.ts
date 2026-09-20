import { app, type BrowserWindow } from "electron";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import type { ProjectRuntime } from "./runtime-host.js";
export async function verifyDesktopSmoke(window:BrowserWindow,runtimes:Map<string,Promise<ProjectRuntime>>,reportDirectory:string){
 const js=(source:string)=>window.webContents.executeJavaScript(source);
 const wait=async(expression:string)=>{for(let i=0;i<200;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,50));}await writeFile(path.join(reportDirectory,"failure-view.txt"),await js("document.body.innerText"));throw new Error(`RENDERER_TIMEOUT: ${expression}`);};
 const click=(selector:string)=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
 await wait('document.querySelector("[data-ready=true]") !== null');
 const isolated=await js('typeof require === "undefined" && typeof process === "undefined" && Object.keys(window.harness).sort().join(",") === "chooseProject,command,events,initialProject,openProject,projects,review"');assert(isolated);
 const emptyStartup=!(await js('window.harness.projects()')).length;
 if(emptyStartup){assert(await js('document.body.innerText.includes("Abrí un repositorio")'));await click('[data-action="open-project"]');await wait('Boolean(document.querySelector("main").dataset.projectKey) && document.querySelector("[data-action=new-session]").disabled === false');}
 const projects=await js('window.harness.projects()');assert.equal(projects.length,1);const firstKey=projects[0].key;
 const first=await runtimes.get(firstKey)!;assert(first.context.runtimePid!==process.pid);
 const duplicate=spawn(process.execPath,[...(app.isPackaged?[]:[app.getAppPath()]),"--smoke-test","--report-directory",reportDirectory],{stdio:"ignore"});
 const duplicateTimer=setTimeout(()=>duplicate.kill("SIGKILL"),10000);
 try{assert.equal(await new Promise<number|null>((resolve,reject)=>{duplicate.once("exit",resolve);duplicate.once("error",reject);}),0);}finally{clearTimeout(duplicateTimer);}

 const rejectedOverrides=await js(`Promise.all([
 window.harness.command(${JSON.stringify(firstKey)},{method:"project.get",projectId:"forged"}).then(()=>false,()=>true),
 window.harness.command(${JSON.stringify(firstKey)},{method:"project.get",workspace:"/"}).then(()=>false,()=>true),
 window.harness.openProject("/arbitrary/path").then(()=>false,()=>true)
 ]).then(r=>r.every(Boolean))`);assert(rejectedOverrides);
 const listFirst=await first.command({method:"session.list"});assert(listFirst.ok&&listFirst.data.kind==="sessions");assert.equal(listFirst.data.sessions.length,0);
 await click('[data-action="new-session"]');await wait('Boolean(document.querySelector("main").dataset.sessionId)');
 const sessionId=await js('document.querySelector("main").dataset.sessionId');
 await js(`const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"Describe the local runtime connection.");field.dispatchEvent(new Event("input",{bubbles:true}));`);
 await wait('document.querySelector("[data-action=start]").disabled === false');await click('[data-action="start"]');await wait('document.body.innerText.includes("completed")');
 await wait('document.querySelector("[data-action=wait]").disabled === false');await click('[data-action="wait"]');await wait('document.querySelector("[data-action=cancel]").disabled === false');await click('[data-action="cancel"]');await wait('document.body.innerText.includes("cancelled")');
 const before=await first.command({method:"session.get",sessionId});assert(before.ok&&before.data.kind==="session");const runIds=before.data.session.runs.map(r=>r.runId);
 await click('[data-action="open-project"]');await wait('document.querySelector("[role=alert]") !== null && document.querySelector("[data-action=open-project]").disabled === false');assert.equal(await js('document.querySelector("main").dataset.projectKey'),firstKey);
 await click('[data-action="open-project"]');await wait(`document.querySelector("main").dataset.projectKey !== ${JSON.stringify(firstKey)} && Boolean(document.querySelector("main").dataset.projectKey)`);
 const secondKey=await js('document.querySelector("main").dataset.projectKey');const second=await runtimes.get(secondKey)!;
 await wait('document.querySelectorAll("[data-session]").length === 0');assert.equal(await js('document.querySelector("[data-action=start]").disabled'),true);
 const foreign=await second.command({method:"session.get",sessionId});assert(!foreign.ok);assert.equal(foreign.error.code,"NOT_FOUND");
 await click('[data-action="new-session"]');await wait('Boolean(document.querySelector("main").dataset.sessionId)');const secondSession=await js('document.querySelector("main").dataset.sessionId');assert.notEqual(secondSession,sessionId);
 await click(`[data-project="${firstKey}"]`);await wait(`document.querySelector("main").dataset.projectKey === ${JSON.stringify(firstKey)} && document.querySelectorAll("[data-session]").length === 1`);
 // Arrow navigation changes focus only; activation via Enter selects the conversation.
 await wait('document.querySelector("[data-session]").disabled === false');window.focus();window.webContents.focus();await js('document.querySelector("[data-session]").focus()');window.webContents.sendInputEvent({type:"keyDown",keyCode:"ArrowDown"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"ArrowDown"});
 assert.equal(await js('document.activeElement.dataset.session'),sessionId);
 window.webContents.sendInputEvent({type:"keyDown",keyCode:"Return"});window.webContents.sendInputEvent({type:"char",keyCode:"\r"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Return"});
 await wait(`document.querySelector("main").dataset.sessionId === ${JSON.stringify(sessionId)} && document.body.innerText.includes("cancelled") && document.body.innerText.includes("Runtime separado")`);
 const after=await first.command({method:"session.get",sessionId});assert(after.ok&&after.data.kind==="session");assert.deepEqual(after.data.session.runs.map(r=>r.runId),runIds);
 const other=await second.command({method:"session.get",sessionId:secondSession});assert(other.ok&&other.data.kind==="session");assert.equal(other.data.session.runs.length,0);
 const loaded=new Promise<void>(resolve=>window.webContents.once("did-finish-load",()=>resolve()));window.webContents.reload();await loaded;await wait('document.querySelector("[data-ready=true]") !== null');assert.equal((await js('window.harness.projects()')).length,2);
 if(emptyStartup){await click(`[data-project="${firstKey}"]`);}
 await wait('document.querySelectorAll("[data-session]").length === 1 && document.querySelector("[data-session]").disabled === false');await click(`[data-session="${sessionId}"]`);await wait('document.body.innerText.includes("cancelled") && document.body.innerText.includes("Runtime separado")');
 // HU28: duplicate submit, actual read/check tools, failed receipt, redaction and reconnect.
 await js(`const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"activity-probe");field.dispatchEvent(new Event("input",{bubbles:true}));`);
 await wait('document.querySelector("[data-action=start]").disabled === false');
 await js('for(let i=0;i<2;i++)document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
 await wait('document.body.innerText.includes("waiting_approval") && document.querySelector("[data-action=wait]").disabled === false');
 const pendingSession=await first.command({method:"session.get",sessionId});assert(pendingSession.ok&&pendingSession.data.kind==="session");assert.equal(pendingSession.data.session.runs.length,runIds.length+1);
 const probeId=pendingSession.data.session.runs.at(-1)!.runId;
 const pending=await first.command({method:"run.get",sessionId,runId:probeId});assert(pending.ok&&pending.data.kind==="run");assert.equal(pending.data.run.status,"waiting_approval");
 await click('[data-action="review"]');await wait('document.querySelector("[data-review-item]") !== null');
 assert(await js('document.querySelector("[data-review-item]").innerText.includes("bun -e")'));
 const reviewed=await first.review(sessionId,probeId);assert.equal(reviewed.revision,pending.data.run.revision);assert.equal(reviewed.items[0]?.digest,pending.data.run.approvals[0]?.digest);
 const resumed=first.command({method:"approval.resolve",sessionId,runId:probeId,expectedRevision:pending.data.run.revision,idempotencyKey:"fixture-probe-approve",decisions:pending.data.run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve:true}))});
 first.setFixtureOffline(true);
 await wait('document.body.innerText.includes("Conexión interrumpida")');
 first.setFixtureOffline(false);
 const reloadActive=new Promise<void>(resolve=>window.webContents.once("did-finish-load",()=>resolve()));window.webContents.reload();await reloadActive;await wait('document.querySelector("[data-ready=true]") !== null');
 if(emptyStartup)await click(`[data-project="${firstKey}"]`);
 await wait('document.querySelector("[data-session]")?.disabled === false');await click(`[data-session="${sessionId}"]`);
 const finished=await resumed;assert(finished.ok&&finished.data.kind==="run");assert.equal(finished.data.run.status,"completed");
 await wait(`document.querySelector('[data-run="${probeId}"] [data-tool="run_check"][data-tool-status="failed"]') !== null && document.body.innerText.includes("parte-39")`);
 assert(await js('document.body.innerText.includes("exit 7") && document.body.innerText.includes("<img src=x onerror=alert(1)>") && !document.querySelector(".timeline img")'));
 const secret=process.env.ZHIVEX_HARNESS_DESKTOP_FIXTURE_SECRET!;
 assert(!(await js('document.body.innerText')).includes(secret));
 const boundary=await js(`window.harness.command(${JSON.stringify(firstKey)},{method:"run.get",sessionId:${JSON.stringify(sessionId)},runId:${JSON.stringify(probeId)}})`);
 assert(!JSON.stringify(boundary).includes(secret));assert(!JSON.stringify(boundary).includes("cliResult"));
 const expired=await first.events({sessionId,after:0});assert(expired.cursorExpired);assert(expired.snapshot?.runs[probeId]?.prompt==="activity-probe");assert.equal(expired.snapshot?.runs[probeId]?.tools?.["tool:probe-check"]?.exitCode,7);
 const finalSession=await first.command({method:"session.get",sessionId});assert(finalSession.ok&&finalSession.data.kind==="session");assert.equal(finalSession.data.session.runs.length,runIds.length+1);
 await js(`document.querySelector('[data-run="${probeId}"] [data-tool="run_check"]').scrollIntoView({block:"center"})`);
 await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 await writeFile(path.join(reportDirectory,"screenshot-chat.png"),(await window.webContents.capturePage()).toPNG());
 first.dropFixtureRunResponse();
 await js(`const field=document.querySelector("#prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"response-loss-probe");field.dispatchEvent(new Event("input",{bubbles:true}));`);
 await wait('document.querySelector("[data-action=start]").disabled === false');await click('[data-action="start"]');
 await wait('document.body.innerText.includes("No se pudo completar.")');assert(await js('document.querySelector("[data-action=start]").disabled'));
 const lost=await first.command({method:"session.get",sessionId});assert(lost.ok&&lost.data.kind==="session");assert.equal(lost.data.session.runs.length,runIds.length+2);
 await click('[data-action="retry"]');await wait('document.querySelector("#prompt").disabled === false && document.body.innerText.includes("response-loss-probe") && !document.body.innerText.includes("No se pudo completar.")');
 const reconciled=await first.command({method:"session.get",sessionId});assert(reconciled.ok&&reconciled.data.kind==="session");assert.deepEqual(reconciled.data.session.runs,lost.data.session.runs);
 assert.equal(await js(`document.querySelector('[data-session="${sessionId}"] small').textContent`),"completed");
 const database=await stat(path.join(first.stateDirectory,"operations.sqlite"));
 await writeFile(path.join(reportDirectory,"screenshot.png"),(await window.webContents.capturePage()).toPNG());
 await writeFile(path.join(reportDirectory,"report.json"),JSON.stringify({schemaVersion:1,platform:process.platform,arch:process.arch,electron:process.versions.electron,hostNode:process.versions.node,runtimeNode:first.context.runtimeNode,separateProcess:true,isolatedRenderer:isolated,rejectedOverrides,sqliteBytes:database.size,streaming:true,cancellation:true,duplicateSubmitPrevented:true,lostResponseReconciled:true,failedCheckVisible:true,redactedRenderer:true,literalRepositoryText:true,activeReconnect:true,expiredSnapshot:true,projectIsolation:true,singleInstance:true,emptyStartup,invalidProjectRecovery:true,selectionHasNoExecution:true,keyboardNavigation:true,rendererReload:true,recentProjects:2,packaged:app.isPackaged,fixture:true},null,2));
}
