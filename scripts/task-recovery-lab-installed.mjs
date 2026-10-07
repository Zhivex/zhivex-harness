// Exact tarball-consumer conventions; no alternate product runner or state store.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const repo = fileURLToPath(new URL('../', import.meta.url));
const [engineArg, codeArg, runtimeArg, outputArg, runtimeTimeoutArg] = process.argv.slice(2);
assert.ok(engineArg && codeArg && runtimeArg && outputArg, 'Pass exact Harness tarball, Code tarball, runtime executable and output directory');
const runtimeTimeoutMs=runtimeTimeoutArg===undefined?90000:Number(runtimeTimeoutArg);
assert.ok(Number.isSafeInteger(runtimeTimeoutMs)&&runtimeTimeoutMs>=1&&runtimeTimeoutMs<=90000,'Runtime timeout can only be shortened');
assert.notEqual(process.platform,'win32','This phase supports native Unix process groups and sockets only');
const engine = path.resolve(engineArg), code = path.resolve(codeArg), output = path.resolve(outputArg);
const root = await mkdtemp('/tmp/hu75-i-');
const env = Object.fromEntries(['PATH','LANG','TMPDIR','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let processCleanupConfirmed = true;
function killGroup(child) {
  try { process.kill(-child.pid,'SIGKILL'); } catch(error) { if (error.code !== 'ESRCH') processCleanupConfirmed = false; }
}
async function run(command, args, cwd = root, timeout = 180000) {
  const child = spawn(command,args,{cwd,detached:true,env:{...env,HOME:root,CI:'1',NO_COLOR:'1',NODE_NO_WARNINGS:'1',npm_config_cache:root+'/cache',HARNESS_RECOVERY_LAB_ROOT:root+'/f'},stdio:['ignore','pipe','pipe']});
  const chunks = [], errors = []; let bytes = 0, timedOut = false, overflow = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(child); },timeout);
  for (const [stream,target] of [[child.stdout,chunks],[child.stderr,errors]]) stream.on('data',data => { bytes += data.length; if(bytes > 4*1024*1024){overflow=true;killGroup(child);}else target.push(data); });
  try {
    // close follows pipe drainage; exit alone can truncate the JSON report.
    const status = await new Promise((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
    if(status!==0 || timedOut || overflow){
      // Native tools may create their own process groups. A forced stop cannot certify their termination.
      processCleanupConfirmed=false;
      const err = new Error(timedOut?'LAB_PROCESS_TIMEOUT':overflow?'LAB_OUTPUT_LIMIT':'LAB_PROCESS_FAILED');
      const diagnostic = Buffer.concat(errors).toString().trim();
      if(command===runtimeArg && diagnostic.startsWith('{')){try{err.evidence=JSON.parse(diagnostic);}catch{}}
      throw err;
    }
    return Buffer.concat(chunks).toString();
  } finally {clearTimeout(timer);killGroup(child);}
}
await mkdir(output,{recursive:true});
const started=Date.now();const binding={};let report;let observation;let stage='source';
try {
  binding.sourceSha=(await run('git',['rev-parse','HEAD'],repo)).trim();
  assert.equal((await run('git',['status','--porcelain'],repo)).trim(),'','Clean source required');
  binding.sourceDirtyAtStart=false;binding.artifactBindingVerified=false;
  const consumer=new URL('./task-recovery-lab-consumer.mjs',import.meta.url), manifestUrl=new URL('../evaluations/task-recovery-lab.json',import.meta.url);
  const consumerBytes=await readFile(consumer),manifestBytes=await readFile(manifestUrl),manifest=JSON.parse(manifestBytes);
  binding.consumerSha256=digest(consumerBytes);binding.manifestSha256=digest(manifestBytes);
  binding.artifacts={};
  for(const[name,file]of[['harness',engine],['code',code]]){const bytes=await readFile(file);binding.artifacts[name]={sha256:digest(bytes),bytes:bytes.length};await writeFile(root+'/'+name+'.tgz',bytes);}
  await writeFile(root+'/consumer.mjs',consumerBytes);
  await writeFile(root+'/package.json',JSON.stringify({private:true,type:'module',dependencies:{'@zhivex-ai/harness':'file:'+root+'/harness.tgz','@zhivex-ai/code':'file:./code.tgz'},overrides:{'@zhivex-ai/harness':'file:'+root+'/harness.tgz'}}));
  stage='install';
  await run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
  stage='resolve-installed';
  const codeRoot=root+'/node_modules/@zhivex-ai/code';
  // The public engine export is ESM/import-only: resolve with its actual import conditions.
  await writeFile(codeRoot+'/lab-binding.mjs',"export const engine = import.meta.resolve('@zhivex-ai/harness/engine');\n");
  await writeFile(root+'/binding.mjs',"import {engine} from './node_modules/@zhivex-ai/code/lab-binding.mjs'; console.log(JSON.stringify({code:engine,root:import.meta.resolve('@zhivex-ai/harness/engine')}));\n");
  const resolved=JSON.parse(await run(runtimeArg,[root+'/binding.mjs']));
  const enginePath=fileURLToPath(resolved.root);
  assert.equal(await realpath(fileURLToPath(resolved.code)),await realpath(enginePath));
  assert.ok((await realpath(enginePath)).startsWith((await realpath(root))+path.sep));
  binding.sameInstalledEngineForCodeAndService=true;binding.versions={};
  for(const name of ['harness','code','core','agents'])binding.versions[name]=JSON.parse(await readFile(root+'/node_modules/@zhivex-ai/'+name+'/package.json','utf8')).version;
  stage='consumer';
  const result=JSON.parse(await run(runtimeArg,[root+'/consumer.mjs'],root,runtimeTimeoutMs));
  stage='verify-evidence';
  assert.equal(result.status,'passed');assert.equal(result.fullStoryAccepted,false);
  assert.equal(result.fixtureSha256,manifest.fixtureSha256,'Frozen fixture mismatch');
  assert.deepEqual(result.scenarios.map(row=>row.id).sort(),[...manifest.installedScenarios].sort(),'Missing or duplicate scenario');
  assert.ok(result.scenarios.every(row=>row.result==='passed'&&row.humanAccepted===false&&row.automaticEffectReplay===false));
  assert.ok(!JSON.stringify(result).includes('<script>')&&!JSON.stringify(result).includes('Synthetic scope sentinel'),'Evidence text leaked');
  observation=result;
  for(const[name,file]of[['harness',engine],['code',code]]){assert.equal(digest(await readFile(file)),binding.artifacts[name].sha256);assert.equal(digest(await readFile(root+'/'+name+'.tgz')),binding.artifacts[name].sha256);}
  assert.equal(digest(await readFile(consumer)),binding.consumerSha256);assert.equal(digest(await readFile(root+'/consumer.mjs')),binding.consumerSha256);
  assert.equal(digest(await readFile(manifestUrl)),binding.manifestSha256);
  assert.equal((await run('git',['rev-parse','HEAD'],repo)).trim(),binding.sourceSha);assert.equal((await run('git',['status','--porcelain'],repo)).trim(),'');
  binding.sourceDirty=false;binding.artifactBindingVerified=true;
  report={...binding,...result,existingCodeUiJourney:'separate installed-journey report required',elapsedMs:Date.now()-started,cleanup:'pending'};
}catch(error){
  report={...binding,...(observation?{observedScenarios:observation.scenarios,observationsVerified:false}:{}),stage,errorCode:['ENOENT','MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)?error.code:null,status:'failed',fullStoryAccepted:false,diagnostic:error instanceof assert.AssertionError?'LAB_BINDING_ASSERTION_FAILED':['LAB_PROCESS_TIMEOUT','LAB_OUTPUT_LIMIT'].includes(error.message)?error.message:'LAB_PROCESS_FAILED',...(error.evidence?{failureEvidence:error.evidence}:{}),cleanup:'pending'};process.exitCode=1;
}finally{
  try{await rm(root,{recursive:true,force:true});await assert.rejects(access(root),{code:'ENOENT'});report.cleanup=processCleanupConfirmed?'completed':'unconfirmed';}
  catch{report.cleanup='unconfirmed';}
  if(report.cleanup!=='completed'){report.status='failed';process.exitCode=1;}
  await writeFile(output+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
