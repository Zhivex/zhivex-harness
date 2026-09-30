import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [artifact,node]=process.argv.slice(2);
if(!artifact||!node) throw new Error('Pass tarball and Node executable.');
// Keep the Unix-domain socket under Darwin's pathname limit.
const root=await mkdtemp('/tmp/har-policy-installed-');
await copyFile(path.resolve(artifact),path.join(root,'harness.tgz'));
await writeFile(path.join(root,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@zhivex-ai/harness':'file:./harness.tgz'}}));
const run=async(args:string[],cwd:string)=>{
  const child=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,HOME:root,TMPDIR:tmpdir()}});
  const timer=setTimeout(()=>child.kill(),60_000);
  try {
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if(code!==0) throw new Error(`Installed check failed (${code}) ${root}: ${stdout}\n${stderr}`);
    return stdout.trim();
  } finally {clearTimeout(timer);}
};
await run([process.execPath,'install','--ignore-scripts'],root);
await copyFile(path.join(import.meta.dir,'policy-observation-installed-consumer.mjs'),path.join(root,'consumer.mjs'));
await writeFile(path.join(root,'no-network.mjs'),"globalThis.fetch=()=>{throw new Error('Unexpected provider request')};");
await mkdir(path.join(root,'workspace'));
const phases=[];
for(const phase of ['prepare','verify']) phases.push(JSON.parse(await run([node,path.join(root,'consumer.mjs'),phase],path.join(root,'workspace'))));
if(process.argv.includes('--oci')) {
  await copyFile(path.join(import.meta.dir,'policy-observation-oci-consumer.mjs'),path.join(root,'oci-consumer.mjs'));
  await mkdir(path.join(root,'oci-workspace'));
  phases.push(JSON.parse(await run([node,path.join(root,'oci-consumer.mjs')],path.join(root,'oci-workspace'))));
}
const report={schemaVersion:1,artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),root,phases,installed:true,liveProvider:false,published:false};
await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
