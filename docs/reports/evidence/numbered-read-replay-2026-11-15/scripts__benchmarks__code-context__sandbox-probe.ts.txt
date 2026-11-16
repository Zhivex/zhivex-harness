import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
const root=realpathSync(await mkdtemp('/tmp/code-context-probe-'));
const outside=root+'-blocked';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reachable')});
try{
 const profile=`(version 1)(allow default)(deny network*)(deny file-read* (subpath "/Users") (subpath "/private/tmp"))(allow file-read* (literal ${JSON.stringify(process.execPath)}) (subpath ${JSON.stringify(root)}))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (subpath "/dev"))`;
 await writeFile(root+'/profile.sb',profile);
 await writeFile(root+'/probe.ts',`import {readFile,writeFile} from 'node:fs/promises';
const result={homeReadBlocked:false,outsideWriteBlocked:false,networkBlocked:false,noCredentials:!process.env.OPENAI_API_KEY};
try{await readFile(${JSON.stringify(process.cwd()+'/package.json')});}catch{result.homeReadBlocked=true;}
try{await writeFile(${JSON.stringify(outside)},'probe');}catch{result.outsideWriteBlocked=true;}
try{await fetch('http://127.0.0.1:${server.port}',{signal:AbortSignal.timeout(1000)});}catch{result.networkBlocked=true;}
console.log(JSON.stringify(result));`);
 const child=Bun.spawn(['/usr/bin/sandbox-exec','-f',root+'/profile.sb',process.execPath,root+'/probe.ts'],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root},stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer);
 assert.equal(exit,0,err);const result=JSON.parse(out);assert(Object.values(result).every(v=>v===true),out);console.log(JSON.stringify(result));
}finally{server.stop(true);await rm(root,{recursive:true,force:true});await rm(outside,{force:true});}
