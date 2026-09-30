import { createHash } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
const [artifact,node]=process.argv.slice(2);
if(!artifact||!node)throw new Error('Pass tarball and Node executable.');
const root=await mkdtemp('/tmp/har-task-installed-');
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
await copyFile(path.join(import.meta.dir,'task-acceptance-installed-consumer.mjs'),path.join(root,'consumer.mjs'));
await mkdir(path.join(root,'workspace'));
const phases=[];
for(const phase of ['prepare','resume'])phases.push(JSON.parse(await run([node,path.join(root,'consumer.mjs'),phase],path.join(root,'workspace'))));
const report={schemaVersion:1,artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),root,phases,installed:true,published:false,liveProvider:false};
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
