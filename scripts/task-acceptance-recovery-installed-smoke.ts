import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const [artifact,node]=process.argv.slice(2);
if(!artifact||!node)throw new Error('Pass tarball and Node executable.');
const root=await mkdtemp('/tmp/har-accept-recovery-');
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
await copyFile(path.join(import.meta.dir,'task-acceptance-recovery-consumer.mjs'),path.join(root,'consumer.mjs'));
const phases=[];
for(const scenario of ['restart','rejection','uncertain','timeout','cancellation','budget','import-crash']) {
  const workspace=path.join(root,scenario);await mkdir(workspace);
  for(const phase of scenario==='import-crash'?['prepare','import-crash','resume']:['prepare', ['timeout','cancellation','budget'].includes(scenario)?'inspect':'resume']) {
    phases.push(JSON.parse(await run([node,path.join(root,'consumer.mjs'),phase,scenario],workspace)));
    await writeFile(path.join(root,'progress.json'),JSON.stringify(phases,null,2)+'\n');
  }
}
const report={schemaVersion:1,artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),root,phases,installed:true,realDocker:true,liveProvider:false,published:false};
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
