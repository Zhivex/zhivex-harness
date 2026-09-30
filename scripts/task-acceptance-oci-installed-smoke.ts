import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {OCI_ACCEPTANCE_FIXTURES,OCI_ACCEPTANCE_REVISION} from './acceptance/fixtures.js';
const [artifact,node]=process.argv.slice(2);
if(!artifact||!node)throw new Error('Pass tarball and Node executable.');
const root=await mkdtemp('/tmp/har-accept-oci-');
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
await copyFile(path.join(import.meta.dir,'task-acceptance-oci-consumer.mjs'),path.join(root,'consumer.mjs'));
const phases=[];
for(const fixture of OCI_ACCEPTANCE_FIXTURES) {
  const scenario=fixture.id;
  const workspace=path.join(root,scenario);await mkdir(workspace);
  const result=JSON.parse(await run([node,path.join(root,'consumer.mjs'),scenario],workspace));
  assert.equal(result.acceptance,fixture.expectedAcceptance);
  assert.equal(result.hostImported,fixture.hostImport);
  phases.push(result);
  await writeFile(path.join(root,'progress.json'),JSON.stringify(phases,null,2)+'\n');
}
const report={schemaVersion:1,cohort:OCI_ACCEPTANCE_REVISION,fixtureSha256:createHash('sha256').update(JSON.stringify(OCI_ACCEPTANCE_FIXTURES)).update(await readFile(path.join(root,'consumer.mjs'))).digest('hex'),artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),root,phases,installed:true,realDocker:true,liveProvider:false,published:false};
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
