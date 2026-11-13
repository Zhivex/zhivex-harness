import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('process death after file effect and before journal completion preserves unknown outcome without replay',async()=>{
 const root=await mkdtemp('/tmp/review-crash-');
 const run=(mode:string)=>new Promise<{code:number|null;signal:string|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn('node',[fileURLToPath(new URL('./fixtures/review-effect-crash.mjs',import.meta.url)),root,mode],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);const timer=setTimeout(()=>child.kill('SIGKILL'),15000);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});});
 try{await mkdir(root+'/repo');execFileSync('git',['init','-q',root+'/repo']);await writeFile(root+'/repo/note.txt','before');const crashed=await run('crash');expect(crashed.signal).toBe('SIGKILL');expect(JSON.parse(await readFile(root+'/effect.json','utf8')).beforeJournalCommit).toBe(true);expect(await readFile(root+'/repo/note.txt','utf8')).toBe('after');const restored=await run('recover');if(restored.code!==0)throw Error(restored.stderr);const evidence=JSON.parse(restored.stdout);expect(evidence.file).toBe('after');expect(evidence.replayAccepted).toBe(false);expect(evidence.decisions[0].status).toBe('unknown');expect(evidence.decisions[0].finalDiff?.status).not.toBe('complete');}finally{await rm(root,{recursive:true,force:true});}
},30000);
