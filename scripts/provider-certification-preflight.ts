import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const [artifactPath,runtimePath,releaseTag,outputPath]=process.argv.slice(2);
assert(artifactPath && runtimePath && releaseTag && outputPath,'Pass tarball, installed entry, release tag and new report path.');
const repo=path.resolve(import.meta.dir,'..');
const root=await mkdtemp('/tmp/hu45-preflight-');
const runtime=path.resolve(runtimePath);
const env={PATH:process.env.PATH,HOME:root,TMPDIR:root,ZHIVEX_HARNESS_LIVE:'1',ZHIVEX_HARNESS_LIVE_PROVIDERS:'anthropic,gemini,vertex',ZHIVEX_HARNESS_LIVE_REQUIRE_ARTIFACT:'1',ZHIVEX_HARNESS_LIVE_RUNTIME:runtime,RELEASE_TAG:releaseTag};
const run=async(script:string,args:string[]=[])=>{
 const child=Bun.spawn([process.execPath,'--no-env-file',repo+'/scripts/'+script,...args],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{const [code,out]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(code,1);return out;}finally{clearTimeout(timer);}
};
const base=JSON.parse(await run('live-provider-smoke.ts'));
assert.equal(base.ok,false);assert.equal(base.providers.length,3);assert(base.providers.every((row:any)=>row.ok===false && row.error.code==='CONFIG_INVALID'));
const continuityPath=root+'/continuity.json';await run('live-continuity-smoke.ts',[continuityPath]);
const continuity=JSON.parse(await readFile(continuityPath,'utf8'));
assert.equal(continuity.status,'failed');assert.equal(continuity.rows.length,3);assert(continuity.rows.every((row:any)=>row.status==='missing_credentials'));
const report={moduleSha256:createHash('sha256').update(await readFile(runtime)).digest('hex'),schemaVersion:1,kind:'credential-free-gate-preflight',root,artifactSha256:createHash('sha256').update(await readFile(path.resolve(artifactPath))).digest('hex'),runtime,providers:['anthropic','gemini','vertex'],base,continuity,providerRequests:0,certified:false};
await writeFile(path.resolve(outputPath),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,baseRejected:3,continuityRejected:3,providerRequests:0,certified:false}));
