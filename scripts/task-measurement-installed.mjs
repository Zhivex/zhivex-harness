// Run with Bun. Installs fixed archives, freezes inputs before opening holdout,
// executes Node public consumers, keeps every registered attempt and negative.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,readdir,rm,access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {sha256,quantiles,costs,evidenceVerdict,negativeEvidence,validateOracle} from './task-measurement-core.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const [engineArg,codeArg,nodeArg,holdoutArg,outputArg]=process.argv.slice(2);
assert(engineArg&&codeArg&&nodeArg&&holdoutArg&&outputArg,'Usage: bun scripts/task-measurement-installed.mjs HARNESS.tgz CODE.tgz NODE HOLDOUT.json NEW_OUTPUT');
const output=path.resolve(outputArg),runtime=path.resolve(nodeArg);
await mkdir(output); // Never overwrite or mix a previous run.
const root=await mkdtemp('/tmp/hu74-installed-');
const env=Object.fromEntries(['LANG','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]]]));
Object.assign(env,{PATH:path.dirname(runtime)+':'+process.env.PATH,HOME:root,CI:'1',NO_COLOR:'1',NODE_NO_WARNINGS:'1',npm_config_cache:root+'/cache'});
let stage='freeze',cleanup=true,report,sequence=0;
const attempts=[],negatives=[],binding={},tracked=[],copies=[],products=[];
const save=(file,value)=>writeFile(output+'/'+file,JSON.stringify(value,null,2)+'\n');
async function run(cmd,args,cwd=root,options={}){
 const child=spawn(cmd,args,{cwd,env,detached:true,stdio:options.handoff?['ignore','pipe','pipe','ipc']:['ignore','pipe','pipe']});
 const chunks=[],errors=[];let size=0,timedOut=false,barrier=false;
 const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')cleanup=false;}};
 const timer=setTimeout(()=>{timedOut=true;kill();},options.timeout??180000);
 for(const [stream,target] of [[child.stdout,chunks],[child.stderr,errors]])stream.on('data',d=>{size+=d.length;if(size>4*1024*1024)kill();else target.push(d);});
 if(options.handoff)child.on('message',message=>{if(message.ready===true){barrier=true;kill();}});
 try{
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  const stdout=Buffer.concat(chunks).toString(),stderr=Buffer.concat(errors).toString();
  if(stderr||result.code!==0)await writeFile(output+'/process-'+(++sequence)+'.log',(stdout+'\n'+stderr).replaceAll(root,'[ISOLATED_ROOT]'));
  if(timedOut){cleanup=false;throw Error('PROCESS_TIMEOUT');}
  if(size>4*1024*1024){cleanup=false;throw Error('PROCESS_OUTPUT_LIMIT');}
  if(options.handoff){assert(barrier&&result.signal==='SIGKILL','Missing durable barrier or termination');return {terminated:true,signal:result.signal};}
  if(result.code!==0)cleanup=false;assert.equal(result.code,0,'PROCESS_FAILED');return stdout;
 }finally{clearTimeout(timer);kill();}
}
async function files(dir,prefix=''){
 const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())result.push(...await files(dir+'/'+entry.name,name+'/'));else{assert(entry.isFile());result.push(name);}}return result.sort();
}
const fixtures=[
 {id:'greeting',exportName:'greeting',objective:'Preserve named greeting(name); return exactly Hello, name! for every valid string.',initial:'export const greeting = name => `Hi, ${name}!`;\n',solution:'export const greeting = name => `Hello, ${name}!`;\n',visible:{id:'visible',input:'Ada',expected:'Hello, Ada!'}},
 {id:'totalActive',exportName:'totalActive',objective:'Preserve named totalActive(rows); sum integer amount where active === true; preserve input.',initial:'export const totalActive = rows => 0;\n',solution:'export const totalActive = rows => rows.reduce((sum, row) => sum + (row.active === true ? row.amount : 0), 0);\n',visible:{id:'visible',input:[{active:true,amount:2},{active:true,amount:3}],expected:5}}
].map(f=>({...f,package:JSON.stringify({private:true,type:'module',scripts:{test:'node check.mjs'}})+'\n',check:`import assert from 'node:assert/strict'; import { ${f.exportName} } from './solution.mjs'; const input = ${JSON.stringify(f.visible.input)}; const before=structuredClone(input); assert.deepEqual(${f.exportName}(input),${JSON.stringify(f.visible.expected)}); assert.deepEqual(input,before);\n`}));
try{
 assert(typeof Bun!=='undefined','Bun is required for evaluation runner');
 binding.evaluatorSourceSha=(await run('git',['rev-parse','HEAD'],repo)).trim();
 assert.equal((await run('git',['status','--porcelain'],repo)).trim(),'','Clean evaluator source required');
 const names=['scripts/task-measurement-installed.mjs','scripts/task-measurement-consumer.mjs','scripts/task-measurement-core.mjs','scripts/task-measurement-oracle.mjs','evaluations/task-measurement.json','docs/reports/har-hu-74/PROTOCOL.md','bun.lock'];
 for(const name of names){const bytes=await readFile(repo+name);tracked.push({path:repo+name,sha256:sha256(bytes)});if(name.startsWith('scripts/')){const copy=root+'/'+path.basename(name);await writeFile(copy,bytes);copies.push({path:copy,sha256:sha256(bytes)});}}
 const manifest=JSON.parse(await readFile(repo+'evaluations/task-measurement.json','utf8'));binding.manifest=manifest;
 binding.inputs=Object.fromEntries(tracked.map(f=>[path.relative(repo,f.path),f.sha256]));
 binding.artifacts={};for(const [name,arg]of [['harness',engineArg],['code',codeArg]]){const bytes=await readFile(arg);assert.equal(sha256(bytes),manifest.artifacts[name]);binding.artifacts[name]=sha256(bytes);await writeFile(root+'/'+name+'.tgz',bytes);copies.push({path:root+'/'+name+'.tgz',sha256:sha256(bytes)});tracked.push({path:path.resolve(arg),sha256:sha256(bytes)});}
 binding.holdoutSha256=sha256(await readFile(holdoutArg));assert.equal(binding.holdoutSha256,manifest.holdoutSha256);
 binding.fixturesSha256=sha256(JSON.stringify(fixtures));binding.environment={os:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,node:(await run(runtime,['--version'])).trim(),bun:Bun.version};
 for(let repetition=1;repetition<=manifest.repetitions;repetition++)for(const fixture of fixtures)for(const journey of manifest.journeys)attempts.push({id:`${fixture.id}-${journey}-${repetition}`,fixture:fixture.id,journey,repetition,status:'registered',humanAccepted:null,humanMinutes:null});
 for(const fixture of fixtures){for(let i=0;i<2;i++)negatives.push({id:`${fixture.id}-wrong-${i+1}`,fixture:fixture.id,kind:'wrong-module',status:'registered'});for(const id of ['stale','incomplete','unsupported','altered-output','protected-drift','unknown-effect'])negatives.push({id:fixture.id+'-'+id,fixture:fixture.id,kind:id,status:'registered'});}
 assert.equal(attempts.length,manifest.positiveAttempts);assert.equal(negatives.length,manifest.negativeCases);
 await save('frozen-manifest.json',{binding,fixtures,attempts,negatives,openedHoldoutContent:false});
 stage='install';await writeFile(root+'/package.json',JSON.stringify({private:true,type:'module',dependencies:{'@zhivex-ai/harness':'file:'+root+'/harness.tgz','@zhivex-ai/code':'file:'+root+'/code.tgz'},overrides:{'@zhivex-ai/harness':'file:'+root+'/harness.tgz'}}));
 await run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
 for(const name of ['harness','code']){const unpack=root+'/packed-'+name;await mkdir(unpack);await run('tar',['-xf',root+'/'+name+'.tgz','-C',unpack]);for(const file of await files(unpack+'/package')){const installed=root+'/node_modules/@zhivex-ai/'+name+'/'+file,hash=sha256(await readFile(unpack+'/package/'+file));assert.equal(sha256(await readFile(installed)),hash);products.push({path:installed,sha256:hash});}}
 binding.installedProductInventory=products.map(p=>({path:path.relative(root,p.path),sha256:p.sha256}));
 binding.packageLockSha256=sha256(await readFile(root+'/package-lock.json'));
 await save('installed-before.json',binding);
 // Generation and instrument are now frozen. Content is read only for the oracle,
 // and is never copied to the agent workspace or its prompt/spec.
 let holdout;
 const bases=new Map();
 for(const attempt of attempts){
  const started=performance.now(),fixture=fixtures.find(f=>f.id===attempt.fixture),workspace=root+'/'+attempt.id,dir=output+'/'+attempt.id;
  attempt.status='started';await save('attempts.json',attempts);await mkdir(workspace);await mkdir(dir);
  try{
   stage='attempt:'+attempt.id;const spec={...fixture,journey:attempt.journey};const specPath=root+'/'+attempt.id+'.spec.json';await writeFile(specPath,JSON.stringify(spec));copies.push({path:specPath,sha256:sha256(JSON.stringify(spec))});
   for(const[name,bytes]of Object.entries({'solution.mjs':fixture.initial,'package.json':fixture.package,'check.mjs':fixture.check}))await writeFile(workspace+'/'+name,bytes);
   await run('git',['init','--quiet'],workspace);await run('git',['add','solution.mjs','package.json','check.mjs'],workspace);await run('git',['-c','user.name=Offline Fixture','-c','user.email=offline@example.invalid','commit','--quiet','-m','Frozen baseline'],workspace);
   const termination=await run(runtime,[root+'/task-measurement-consumer.mjs','run',workspace,specPath,dir],root,{handoff:attempt.journey==='handoff'});
   if(attempt.journey==='handoff'){attempt.previousProcess=termination;await run(runtime,[root+'/task-measurement-consumer.mjs','read',workspace,specPath,dir]);}
   const result=JSON.parse(await readFile(dir+'/consumer.json','utf8'));
   if(!holdout){holdout=JSON.parse(await readFile(holdoutArg,'utf8'));assert.equal(holdout.fixtures.length,fixtures.length);}
   const hidden=holdout.fixtures.find(f=>f.id===fixture.id);assert(hidden&&hidden.exportName===fixture.exportName&&hidden.cases.length===3&&hidden.wrongImplementations.length===2);
   const cases=[fixture.visible,...hidden.cases];const casesPath=root+'/'+fixture.id+'-cases.json';await writeFile(casesPath,JSON.stringify(cases));
   const oracleStart=performance.now(),oracle=JSON.parse(await run(runtime,[root+'/task-measurement-oracle.mjs',workspace+'/solution.mjs',casesPath,fixture.exportName],root,{timeout:10000}));
   const oracleMs=performance.now()-oracleStart;
   validateOracle(oracle,sha256(result.artifact),sha256(JSON.stringify(cases)));assert.equal(sha256(await readFile(workspace+'/solution.mjs')),result.identity.artifactSha256);
   const task=result.projection.task,evidence={schemaVersion:1,artifactSha256:result.identity.artifactSha256,structure:task.review.structure,correspondence:task.artifact.correspondence,checks:task.review.checks,protectedIntact:result.protectedIntact,unknownEffects:task.effects.unknown,missingEvidence:task.effects.missingEvidence,support:task.provenance,observedVisibleOutput:oracle.observed[0],reportedVisibleOutput:fixture.visible.expected};
   const verdict=evidenceVerdict(evidence,sha256(result.artifact));
   Object.assign(attempt,{status:oracle.accepted&&verdict.accepted?'passed':'failed',oraclePassed:oracle.accepted&&verdict.accepted,oracle,evidenceVerdict:verdict,artifactSha256:result.identity.artifactSha256,latency:{executionMs:result.generation.executionMs,...result.latency,oracleMs},confirmedTokens:result.budget.confirmed,originalAccountSnapshot:result.budget,
    repeatedWork:{modelCalls:result.generation.modelCalls,additionalModelCallsForRead:result.readModelCalls,observedJournalEntries:result.journalEntries,expectedEdits:1,expectedChecks:1,automaticReplay:false},firstAttempt:true,recoveryRead:attempt.journey==='handoff'});
   if(attempt.oraclePassed&&!bases.has(fixture.id))bases.set(fixture.id,{evidence,artifact:result.artifact,casesPath,hidden,fixture});
  }catch(error){attempt.status=error.message==='PROCESS_TIMEOUT'?'timeout':'failed';attempt.error=error.message;attempt.oraclePassed=false;
   try{await run(runtime,[root+'/task-measurement-consumer.mjs','audit',workspace,root+'/'+attempt.id+'.spec.json',dir],root,{timeout:15000});attempt.failureAccount=JSON.parse(await readFile(dir+'/failure-account.json','utf8'));}catch(auditError){attempt.failureAccount={budget:null,missingBudget:true,error:auditError.message};}
  }
  finally{attempt.elapsedMs=performance.now()-started;await save('attempts.json',attempts);await rm(workspace,{recursive:true,force:true});}
 }
 stage='negative-controls';
 for(const negative of negatives){negative.status='started';await save('negatives.json',negatives);const base=bases.get(negative.fixture);
  try{
   assert(base,'No positive base: negative cannot be credited');let accepted;
   if(negative.kind==='wrong-module'){
    const index=Number(negative.id.at(-1))-1,wrong=base.hidden.wrongImplementations[index],modulePath=root+'/'+negative.id+'.mjs';await writeFile(modulePath,wrong.moduleSource);
    const visible=root+'/'+negative.id+'-visible.json';await writeFile(visible,JSON.stringify([base.fixture.visible]));
    const control=JSON.parse(await run(runtime,[root+'/task-measurement-oracle.mjs',modulePath,visible,base.fixture.exportName],root,{timeout:10000}));validateOracle(control,sha256(wrong.moduleSource),sha256(JSON.stringify([base.fixture.visible])));assert.equal(control.accepted,true,'Negative must pass visible example');
    const verdict=JSON.parse(await run(runtime,[root+'/task-measurement-oracle.mjs',modulePath,base.casesPath,base.fixture.exportName],root,{timeout:10000}));validateOracle(verdict,sha256(wrong.moduleSource),sha256(await readFile(base.casesPath)));accepted=verdict.accepted;negative.oracle=verdict;negative.moduleSha256=sha256(wrong.moduleSource);
   }else{const mutation=negativeEvidence(base.evidence).find(row=>row.id===negative.kind);const verdict=evidenceVerdict(mutation.evidence,sha256(base.artifact));accepted=verdict.accepted;negative.oracle=verdict;}
   negative.status=accepted?'false_acceptance':'rejected';
  }catch(error){negative.status='instrument_error';negative.error=error.message;}
  await save('negatives.json',negatives);
 }
 stage='verify';
 for(const file of [...products,...tracked,...copies])assert.equal(sha256(await readFile(file.path)),file.sha256,'Changed bound byte: '+path.basename(file.path));
 assert.equal(sha256(await readFile(holdoutArg)),binding.holdoutSha256);
 assert.equal((await run('git',['rev-parse','HEAD'],repo)).trim(),binding.evaluatorSourceSha);assert.equal((await run('git',['status','--porcelain'],repo)).trim(),'');
 const groups=[];for(const fixture of fixtures)for(const journey of manifest.journeys){const rows=attempts.filter(a=>a.fixture===fixture.id&&a.journey===journey),passed=rows.filter(a=>a.status==='passed');groups.push({fixture:fixture.id,journey,registered:rows.length,passed:passed.length,failed:rows.filter(a=>a.status==='failed').length,timeouts:rows.filter(a=>a.status==='timeout').length,latency:Object.fromEntries(['executionMs','baselineMaterializationMs','projectionReadMs','reopenAndReadMs','oracleMs'].map(key=>[key,quantiles(passed.flatMap(a=>a.latency[key]===null?[]:[a.latency[key]]))]))});}
 const ledger=attempts.flatMap(a=>[{id:a.id+'-model',taskId:a.id,category:'attempt',status:'not_applicable',amount:null,reason:'Synthetic model: no LLM invoice or production price'}, {id:a.id+'-infra',taskId:a.id,category:'infrastructure',status:'unknown',amount:null,reason:'Infrastructure cost not metered'}, {id:a.id+'-review',taskId:a.id,category:'review',status:'unknown',amount:null,reason:'No human review performed'}]);
 await save('cost-ledger.json',ledger);
 report={binding,status:attempts.every(a=>a.status==='passed')&&negatives.every(n=>n.status==='rejected')?'passed':'failed',groups,attempts,negatives,denominators:{registered:attempts.length,oraclePassed:attempts.filter(a=>a.oraclePassed).length,humanAccepted:0,humanAcceptanceMeasured:false,negativeRegistered:negatives.length,negativeRejected:negatives.filter(n=>n.status==='rejected').length},
  costs:{humanAccepted:costs(ledger,[]),oracleAccepted:costs(ledger,attempts.filter(a=>a.oraclePassed).map(a=>a.id))},humanMinutes:null,humanQuality:null,realCostPerAcceptedTask:null,productivityClaim:false,liveProvider:false,humanPilotPerformed:false,storyComplete:false};
 if(report.status!=='passed')process.exitCode=1;
}catch(error){report={binding,status:'failed',stage,error:error.message,attempts,negatives,storyComplete:false};process.exitCode=1;}
finally{try{await rm(root,{recursive:true,force:true});await assert.rejects(access(root),{code:'ENOENT'});}catch{cleanup=false;}report.cleanup=cleanup?'completed':'unconfirmed';if(!cleanup){report.status='failed';process.exitCode=1;}await save('report.json',report);console.log(JSON.stringify({status:report.status,stage:report.stage,denominators:report.denominators,cleanup:report.cleanup,output}));}
