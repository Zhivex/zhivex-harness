import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [artifact,node]=process.argv.slice(2);
if(!artifact||!node)throw new Error('Pass tarball and Node executable.');
const root=await mkdtemp('/tmp/har-provider-compaction-');
await copyFile(path.resolve(artifact),path.join(root,'harness.tgz'));
await writeFile(path.join(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@zhivex-ai/harness':'file:./harness.tgz'}}));
const run=async(args:string[],cwd:string)=>{
  const child=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:root,TMPDIR:process.env.TMPDIR}});
  const timer=setTimeout(()=>child.kill(),60_000);
  try{const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(code)throw new Error(`Acceptance failed (${root}): ${out}\n${err}`);return out.trim();
  }finally{clearTimeout(timer);}
};
await run([process.execPath,'install','--ignore-scripts'],root);
await copyFile(path.join(import.meta.dir,'provider-compaction-installed-consumer.mjs'),path.join(root,'consumer.mjs'));
const phases=[];
for(const provider of ['vertex','anthropic','gemini']) {
  const workspace=path.join(root,provider);await mkdir(workspace);
  for(const phase of ['request','resume']) {
    const result=JSON.parse(await run([node,path.join(root,'consumer.mjs'),phase,provider],workspace));
    assert.equal(result.passed,true);phases.push(result);
    await writeFile(path.join(root,'progress.json'),JSON.stringify(phases,null,2)+'\n');
  }
}
const report={schemaVersion:1,cohort:"provider-signed-compaction-v1",
  fixtureSha256:createHash('sha256').update(await readFile(path.join(root,'consumer.mjs'))).digest('hex'),
  artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),root,phases,installed:true,runtime:node,liveProvider:false,published:false,limitations:["Synthetic signatures and mocked transport; no provider server validation", "Vertex adapter receives fixture ADC callback; not an ADC/IAM test"]};
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
