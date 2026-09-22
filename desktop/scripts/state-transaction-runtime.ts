import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {resolveHarnessConfig} from "../../src/runtime/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/persistence/operations.js";
import {openCliSessionStore} from "../../src/persistence/sessions.js";
import {openHarnessActivityStore} from "../../src/client/service-events.js";
import {SqliteDatabase} from "../../src/persistence/sqlite-database.js";
import {checkDesktopStateFormat} from "../src/state-format.js";
import {prepareDesktopStateTransaction, armDesktopStateTransaction, restoreDesktopStateTransaction, finishDesktopStateTransaction} from "../src/state-transaction.js";

async function fixture(run: (f: {root: string; userData: string; configs: ReturnType<typeof resolveHarnessConfig>[]}) => Promise<void>) {
 const root = await realpath(await mkdtemp("/tmp/har-state-transaction-")), userData = path.join(root, "profile"); await mkdir(userData);
 const configs = [];
 for (let i = 0; i < 2; i++) {
  const workspace = path.join(root, `repo${i}`), stateDirectory = path.join(root, `state${i}`); await mkdir(workspace); await mkdir(stateDirectory, {mode: 0o700});
  const config = resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"});
  const p = await openHarnessPersistence(config); p.close();
  const sessions = await openCliSessionStore({workspace, stateDirectory, scope: config.scope});
  const session = await sessions.create({title: `original ${i}`}); sessions.close();
  const activity = await openHarnessActivityStore(config); activity.prompt(session.sessionId, "fixture", `original prompt ${i}`); activity.checkpoint(session.sessionId, "fixture", "completed"); activity.close();
  configs.push(config);
 }
 await mkdir(path.join(userData, "projects"), {mode: 0o700}); await writeFile(path.join(userData, "projects/projects.json"), '{"schemaVersion":1,"projects":[]}', {mode: 0o600});
 try {await run({root, userData, configs});} finally {await rm(root, {recursive: true, force: true});}
}
function mutate(config: ReturnType<typeof resolveHarnessConfig>) {
 const db = new SqliteDatabase(path.join(config.stateDirectory, HARNESS_SQLITE_FILE));
 try {db.exec("UPDATE zhivex_cli_sessions SET title='changed by migration'; DELETE FROM client_activity_events; CREATE TABLE migration_table(value TEXT)");} finally {db.close();}
}
function title(config: ReturnType<typeof resolveHarnessConfig>) {
 const db = new SqliteDatabase(path.join(config.stateDirectory, HARNESS_SQLITE_FILE), {readonly: true});
 try {return db.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title;} finally {db.close();}
}

void fixture(async f => {
 const transaction=await prepareDesktopStateTransaction(f.userData,f.configs);
 await armDesktopStateTransaction(f.userData,transaction); f.configs.forEach(mutate);
 let interrupted=false;
 try {await restoreDesktopStateTransaction(f.userData,{assertStopped:async()=>{},afterWrite:async()=>{throw new Error("fixture interruption");}});} catch {interrupted=true;}
 assert.equal(interrupted,true);
 assert.deepEqual(f.configs.map(title),["original 0","changed by migration"]);
 await assert.rejects(checkDesktopStateFormat(f.userData));
 await restoreDesktopStateTransaction(f.userData,{assertStopped:async()=>{}});
 assert.deepEqual(f.configs.map(title),["original 0","original 1"]);
 await finishDesktopStateTransaction(f.userData,async()=>{});await checkDesktopStateFormat(f.userData);
 const report={node:process.versions.node,electron:process.versions.electron,databases:2,interruptionRecovered:true,pass:true};
 const evidence=await mkdtemp("/tmp/har-state-recovery-report-");await writeFile(path.join(evidence,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({evidence,...report}));
}).catch(()=>{console.error("NATIVE_STATE_RECOVERY_FAILED");process.exitCode=1;});
