/** One predeclared campaign; no selective retries or in-place output replacement. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,open,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPilotModel} from './acceptance/pilot-adapters.js';
import {ACCEPTANCE_FIXTURES,ACCEPTANCE_LIMITS} from './acceptance/fixtures.js';
import {runPilotCase} from './acceptance/pilot-case.js';
import {compileCompetitivePilotPlan,pilotDigest,pilotFixtureIdentity,summarizeCompetitivePilot,competitivePilotAttemptSchema,type CompetitivePilotAttempt} from './acceptance/pilot-protocol.js';

const digest=(bytes:Uint8Array|string)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const read=async(file:string)=>JSON.parse(await readFile(file,'utf8'));
const inputs=['scripts/competitive-pilot-live.ts','scripts/acceptance/pilot-adapters.ts','scripts/acceptance/pilot-budget.ts','scripts/acceptance/pilot-case.ts','scripts/acceptance/pilot-protocol.ts','scripts/acceptance/fixtures.ts','src/execution/process-runtime.ts','src/context/context-metrics.ts','bun.lock'];
const tree=async(directory:string,prefix=''):Promise<Record<string,string>>=>{
 const result:Record<string,string>={};
 for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){
  const relative=path.join(prefix,entry.name);
  if(entry.isDirectory())Object.assign(result,await tree(directory,relative));
  else {assert(entry.isFile(),'PILOT_NON_REGULAR_INPUT');result[relative]=digest(await readFile(path.join(directory,relative)));}
 }return result;
};
async function inventory(runtime:string){
 const files:Record<string,string>={};for(const file of inputs)files[file]=digest(await readFile(file));
 const dependencies:Record<string,unknown>={};
 for(const name of ['core','anthropic','agents']){const root=`node_modules/@zhivex-ai/${name}`;dependencies[name]={version:(await read(`${root}/package.json`)).version,dist:await tree(`${root}/dist`)};}
 const installedDependencies:Record<string,unknown>={};
 for(const name of ['core','anthropic','agents']){
  const root=path.resolve(path.dirname(Bun.resolveSync(`@zhivex-ai/${name}`,runtime)),'..');
  installedDependencies[name]={version:(await read(path.join(root,'package.json'))).version,dist:await tree(path.join(root,'dist'))};
 }
 assert.deepEqual(installedDependencies,dependencies,'PILOT_DEPENDENCY_MISMATCH');
 return {files,dependencies,installedDependencies,harnessDist:await tree(runtime)};
}
const engine=async(runtime:string):Promise<typeof import('../src/engine/index.js')>=>import(pathToFileURL(path.join(runtime,'engine/index.js')).href);
const [command,...args]=process.argv.slice(2);
async function main(){
 if(command==='prepare'){
  const [artifactArg,runtimeArg,evidenceArg,outputArg,modelId]=args;assert(artifactArg&&runtimeArg&&evidenceArg&&outputArg&&modelId);
  const artifact=path.resolve(artifactArg),runtime=path.resolve(runtimeArg),evidencePath=path.resolve(evidenceArg),output=path.resolve(outputArg);
  const artifactDigest=digest(await readFile(artifact)),cert=await read(evidencePath);
  assert.equal('sha256:'+cert.artifactSha256,artifactDigest);assert.equal(cert.selectedGatesPassed,true);
  assert(cert.matrix.some((row:{provider:string;model:string})=>row.provider==='anthropic'&&row.model===modelId));
  const temporary=await mkdtemp('/tmp/har-pilot-artifact-');
  try {const child=Bun.spawn(['tar','-xzf',artifact,'-C',temporary,'package/dist'],{stdout:'ignore',stderr:'ignore'});assert.equal(await child.exited,0);assert.deepEqual(await tree(path.join(temporary,'package/dist')),await tree(runtime));}finally{await rm(temporary,{recursive:true,force:true});}
  const frozen=await inventory(runtime);
  const model={provider:'anthropic',id:modelId,route:'direct-api',settingsDigest:pilotDigest({temperature:'provider-default',transport:'stream',retryPolicy:'SDK-defaults',outputCap:'remaining-case-budget'})};
  const shared={code:frozen.files,dependencies:frozen.dependencies,budget:ACCEPTANCE_LIMITS,model};
  const sdkVersion=(await read('node_modules/@zhivex-ai/core/package.json')).version;
  const version=(await read(path.join(runtime,'../package.json'))).version;
  const plan={schemaVersion:1,kind:'competitive-pilot-plan',comparison:'same-model-harness',fixtures:{...pilotFixtureIdentity(),ids:ACCEPTANCE_FIXTURES.map(f=>f.id)},
   participants:[{id:'harness',tool:'harness',version,artifactDigest,configurationDigest:pilotDigest({...shared,participant:'harness'}),model,budgetSupport:'enforced'},
    {id:'sdk-reference',tool:'sdk-reference',version:'core-'+sdkVersion,artifactDigest:pilotDigest({adapter:frozen.files['scripts/acceptance/pilot-adapters.ts'],dependencies:frozen.dependencies}),configurationDigest:pilotDigest({...shared,participant:'sdk-reference'}),model,budgetSupport:'enforced'}],
   budget:ACCEPTANCE_LIMITS,approvalPolicyDigest:pilotDigest({driver:frozen.files['scripts/acceptance/pilot-case.ts'],policy:'allowlisted fixture changes and exact protected test command; automatic approvals'}),
   repetitions:3,maximumAttempts:1,retryPolicy:'failed-only',order:'rotating-participants',certificationEvidenceDigest:digest(await readFile(evidencePath))};
  const compiled=compileCompetitivePilotPlan(plan);
  await mkdir(output);await writeFile(path.join(output,'lock.json'),JSON.stringify({...compiled,createdAt:new Date().toISOString(),artifact,runtime,evidencePath,frozen},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`Locked ${compiled.schedule.length} cases. No provider calls.`);return;
 }
 if(command==='worker'){
  assert.equal(process.env.ZHIVEX_HARNESS_LIVE,'1');assert(process.env.ANTHROPIC_API_KEY);assert(!process.env.ANTHROPIC_BASE_URL);
  const [runtime,participant,fixtureId,modelId]=args;assert(runtime&&modelId&&(participant==='harness'||participant==='sdk-reference'));
  const fixture=ACCEPTANCE_FIXTURES.find(f=>f.id===fixtureId);assert(fixture);
  const api=await engine(runtime);
  const model=createPilotModel(api,modelId,process.env.ANTHROPIC_API_KEY);
  const row=await runPilotCase(api,participant,fixture,model,modelId);console.log(JSON.stringify(row));return;
 }
 assert.equal(command,'run');assert.equal(process.env.ZHIVEX_HARNESS_LIVE,'1');assert(process.env.ANTHROPIC_API_KEY);assert(!process.env.ANTHROPIC_BASE_URL);
 const [outputArg]=args;assert(outputArg);const output=path.resolve(outputArg),lock=await read(path.join(output,'lock.json'));
 const compiled=compileCompetitivePilotPlan(lock.plan);assert.equal(compiled.digest,lock.digest);assert.deepEqual(compiled.schedule,lock.schedule);
 assert.deepEqual(await inventory(lock.runtime),lock.frozen);assert.equal(digest(await readFile(lock.artifact)),lock.plan.participants[0].artifactDigest);assert.equal(digest(await readFile(lock.evidencePath)),lock.plan.certificationEvidenceDigest);
 const journal=await open(path.join(output,'attempts.jsonl'),'wx',0o600);const rows:CompetitivePilotAttempt[]=[];
 try{
  for(const [index,cell] of compiled.schedule.entries()){
   assert.deepEqual(await inventory(lock.runtime),lock.frozen,'PILOT_INPUT_CHANGED');
   const started=Date.now();const child=Bun.spawn([process.execPath,'--no-env-file',import.meta.path,'worker',lock.runtime,cell.participantId,cell.fixtureId,compiled.plan.participants.find(p=>p.id===cell.participantId)!.model.id],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,ZHIVEX_HARNESS_LIVE:'1',ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY},stdout:'pipe',stderr:'pipe'});
   let killed=false;const timer=setTimeout(()=>{killed=true;child.kill();},compiled.plan.budget.timeoutMs+1000);
   const [stdout,_stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);
   let observation:Awaited<ReturnType<typeof runPilotCase>>|undefined;
   if(!exitCode)try{observation=JSON.parse(stdout);}catch{/* Missing observations remain unknown. */}
   const evidence={cell,exitCode,killed,durationMs:Date.now()-started,observation:observation??null};
   const evidenceBytes=JSON.stringify(evidence,null,2)+'\n';await writeFile(path.join(output,`case-${index+1}.json`),evidenceBytes,{flag:'wx',mode:0o600});
   const participant=compiled.plan.participants.find(p=>p.id===cell.participantId)!;
   const row=competitivePilotAttemptSchema.parse({schemaVersion:1,planDigest:compiled.digest,...cell,attempt:1,
    artifactDigest:participant.artifactDigest,configurationDigest:participant.configurationDigest,modelDigest:pilotDigest(participant.model),budgetDigest:compiled.budgetDigest,approvalPolicyDigest:compiled.plan.approvalPolicyDigest,
    status:observation?.status??'failed',independentTestsPassed:observation?.independentTestsPassed??false,protectedFilesUnchanged:observation?.protectedFilesUnchanged??false,
    evidenceDigest:digest(evidenceBytes),diagnostic:observation?.diagnostic??(killed?'budget_exhausted':'interrupted'),durationMs:observation?.durationMs??evidence.durationMs,
    steps:observation?.steps??null,toolCalls:observation?.toolCalls??null,inputTokens:observation?.usageComplete?observation.inputTokens:null,outputTokens:observation?.usageComplete?observation.outputTokens:null,usageComplete:observation?.usageComplete??false,
    costUsd:null,pricingEvidenceDigest:null,costKind:'estimate-not-invoice',humanInterventions:observation?.humanInterventions??null,automatedApprovals:observation?.automatedApprovals??null,scriptedUserCorrections:observation?.scriptedUserCorrections??null});
   rows.push(row);summarizeCompetitivePilot(compiled.plan,rows);
   await journal.writeFile(JSON.stringify(row)+'\n');await journal.sync();
   console.log(`${index+1}/${compiled.schedule.length} ${cell.participantId}/${cell.fixtureId}/${cell.repetition}: ${row.status}`);
  }
  const summary=summarizeCompetitivePilot(compiled.plan,rows);await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx',mode:0o600});
 }finally{await journal.close();}
}
main().catch(()=>{process.stderr.write('Pilot failed; inspect preserved sanitized observations and journal. No automatic restart.\n');process.exitCode=1;});
