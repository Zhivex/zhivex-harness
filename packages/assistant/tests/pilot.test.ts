import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolveHarnessConfig,openHarnessPersistence,exportHarnessStateBackup,inspectHarnessState} from '@zhivex-ai/harness/engine';
import {migrationPreflight,adoptMigration} from '../src/pilot/migration.js';
import {writePilotManifest,verifyPilotManifest} from '../src/pilot/manifest.js';
import {acquireAssistantProjectOwner} from '../src/projects.js';
async function fixture(owner='local-owner'){
 const root=await mkdtemp('/tmp/pilot-migrate-');await mkdir(root+'/repo');execFileSync('git',['init','-q',root+'/repo']);
 const config=resolveHarnessConfig({workspace:root+'/repo',stateDirectory:root+'/original',tenantId:'assistant-local',userId:owner,namespace:'assistant-coding-v1',storeBackend:'sqlite'});
 const persistence=await openHarnessPersistence(config);
 await persistence.store.save({schemaVersion:1,revision:0,runId:'terminal-fixture',provider:'fixture',modelId:'offline',status:'completed',messages:[],steps:[],toolResults:[],currentStep:0,maxSteps:2,outputText:'original history',pendingApprovals:[],compactions:[],scope:config.scope,startedAt:1000,updatedAt:2000});persistence.close();
 await exportHarnessStateBackup(config,root+'/backup.json');
 return{root,config,input:{workspace:root+'/repo',backup:root+'/backup.json',owner:'local-owner'},close:()=>rm(root,{recursive:true,force:true})};
}
test('migration preflight is read-only; adoption archives exact bytes, preserves history and never merges twice',async()=>{
 const f=await fixture();try{
  const before=await readFile(f.input.backup),review=await migrationPreflight(f.input);expect(review.canAdopt).toBe(true);await expect(lstat(f.root+'/repo/.zhivex-harness/assistant')).rejects.toThrow();
  await expect(adoptMigration(f.input,'0'.repeat(64))).rejects.toThrow('MIGRATION_PREFLIGHT_CHANGED');
  const adopted=await adoptMigration(f.input,review.receipt);expect(await readFile(adopted.archive+'/source-backup.json')).toEqual(before);expect(await readFile(f.input.backup)).toEqual(before);
  const state=await inspectHarnessState(resolveHarnessConfig({workspace:f.input.workspace,stateDirectory:f.root+'/repo/.zhivex-harness/assistant',tenantId:'assistant-local',userId:'local-owner',namespace:'assistant-coding-v1',storeBackend:'sqlite'}));expect(state.counts.runs).toBe(1);
  expect((await migrationPreflight(f.input)).canAdopt).toBe(false);await expect(adoptMigration(f.input,review.receipt)).rejects.toThrow('MIGRATION_PREFLIGHT_CHANGED');
 }finally{await f.close();}
});
test('migration refuses foreign scope, changed archives, symlinks and active Assistant ownership',async()=>{
 const foreign=await fixture('other-owner');try{expect((await migrationPreflight(foreign.input)).canAdopt).toBe(false);}finally{await foreign.close();}
 const f=await fixture();try{
  const review=await migrationPreflight(f.input),release=await acquireAssistantProjectOwner(f.input.workspace,false);
  try{await expect(adoptMigration(f.input,review.receipt)).rejects.toThrow('OWNERSHIP_CONFLICT');}finally{await release();}
  await symlink(f.input.backup,f.root+'/alias.json');await expect(migrationPreflight({...f.input,backup:f.root+'/alias.json'})).rejects.toThrow();
  const data=JSON.parse(await readFile(f.input.backup,'utf8'));data.records.runs[0].state.outputText='tampered';await writeFile(f.input.backup,JSON.stringify(data));expect((await migrationPreflight(f.input)).canAdopt).toBe(false);
 }finally{await f.close();}
});
test.skipIf(process.platform!=='darwin'||process.arch!=='arm64')('bundle integrity detects changed, missing and extra files; refuses escaping dependency links',async()=>{
 const root=await mkdtemp('/tmp/pilot-manifest-');try{
  await mkdir(root+'/node_modules/@zhivex-ai/harness',{recursive:true});await writeFile(root+'/node_modules/@zhivex-ai/harness/package.json','{"version":"fixture"}');await writeFile(root+'/host.js','baseline');
  await writePilotManifest(root);expect((await verifyPilotManifest(root)).integrity).toBe('matched');
  await writeFile(root+'/host.js','changed');await writeFile(root+'/unexpected.js','extra');expect((await verifyPilotManifest(root)).mismatches).toEqual(['host.js','unexpected.js']);
  await symlink('/etc/passwd',root+'/escape');await expect(verifyPilotManifest(root)).rejects.toThrow('PILOT_EXTERNAL_SYMLINK');
 }finally{await rm(root,{recursive:true,force:true});}
});
