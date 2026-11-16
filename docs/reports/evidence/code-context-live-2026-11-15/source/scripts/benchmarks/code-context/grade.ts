import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fixture } from './fixtures.js';
export const testsFor=(task:string)=>task==='path-policy'?`
import {test,expect} from 'bun:test';
import {isSensitiveName,isHardIgnored} from './candidate.ts';
test('sensitive basenames, extensions, case and nested exclusions',()=>{
 for(const p of ['ID_RSA','id_ed25519','.ENV','.Env.Local','.NPMRC','SERVER.PEM','a.KEY','a.p12','a.PFX'])expect(isSensitiveName(p)).toBe(true);
 for(const p of ['.GIT/HEAD','src/.NPMRC','keys/SERVER.PEM','SRC/NODE_MODULES/a','src/.env.example.local'])expect(isHardIgnored(p)).toBe(true);
});
test('allowed examples, ordinary paths and suffix boundaries',()=>{
 for(const p of ['.ENV.EXAMPLE','.env.example','config.pem.txt','distribution','README.md'])expect(isSensitiveName(p)).toBe(false);
 for(const p of ['src/.ENV.EXAMPLE','src/README.md','distribution/index.ts','src/notnode_modules/x'])expect(isHardIgnored(p)).toBe(false);
});
test('case variants exhaustive ASCII combinations',()=>{
 for(const name of ['id_rsa','.git','.npmrc'])for(let mask=0;mask<1<<name.length;mask++){
 const p=Array.from(name,(c,i)=>mask&(1<<i)?c.toUpperCase():c).join('');expect(isHardIgnored('a/'+p+'/child')).toBe(true);
 }
});`:`
import {test,expect} from 'bun:test';
import {firstDisallowedControl as text,firstDisallowedControlBytes as bytes,textGuards} from './candidate.ts';
test('all text control boundaries and line labels',()=>{
 for(let n=0;n<=0xff;n++){const hit=text('first\\nsecond\\n'+String.fromCharCode(n));
 const bad=(n<32&&![9,10,13].includes(n))||n===127||(n>=128&&n<=159);
 expect(!!hit).toBe(bad);if(bad){expect(hit!.line).toBe(3);expect(hit!.label).toBe(n===0?'NUL byte':'U+'+n.toString(16).padStart(4,'0'));}}
});
test('byte scanner preserves UTF8 continuation bytes',()=>{
 for(let n=0;n<256;n++)expect(!!bytes(new Uint8Array([n]))).toBe((n<32&&![9,10,13].includes(n))||n===127);
 for(const s of ['café','😀','中文','tab\\tline\\r\\n'])expect(bytes(new TextEncoder().encode(s))).toBeUndefined();
});
test('host bypass and error boundary unchanged',()=>{
 expect(()=>textGuards.beforeWrite('x\\n\\u009f',false)).toThrow('U+009f at L2');
 expect(()=>textGuards.beforeWrite('\\0',true)).not.toThrow();
 expect(textGuards.afterWrite(new Uint8Array([0]),true)).toBeUndefined();
 expect(textGuards.afterWrite(new Uint8Array([10,0]),false)).toEqual({line:2,label:'NUL byte'});
});`;
export async function executeTests(task:string,code:string){
 const root=realpathSync(await mkdtemp('/tmp/code-context-grade-'));
 try{
  // The only import in these two repository modules is this error class.
  code=code.replace('"../runtime/errors.js"','"./errors.ts"');
  await writeFile(`${root}/candidate.ts`,code);
  await writeFile(`${root}/errors.ts`,'export class HarnessWorkspaceError extends Error {}');
  await writeFile(`${root}/candidate.test.ts`,testsFor(task));
  const profile=`(version 1)(allow default)(deny network*)(deny file-read* (subpath "/Users") (subpath "/private/tmp"))(allow file-read* (literal ${JSON.stringify(process.execPath)}) (subpath ${JSON.stringify(root)}))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (subpath "/dev"))`;
  await writeFile(`${root}/sandbox.sb`,profile);
  const child=Bun.spawn(['/usr/bin/sandbox-exec','-f',`${root}/sandbox.sb`,process.execPath,'test','./candidate.test.ts'],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer);
  const output=(stdout+stderr).replaceAll(root,'<isolated>');
  return {passed:exit===0 && /3 pass/.test(output)&&/0 fail/.test(output),exit,output:output.slice(-12000)};
 }finally{await rm(root,{recursive:true,force:true});}
}
export async function grade(data:Awaited<ReturnType<typeof fixture>>,answer:string){
 let candidate=data.buggy;
 try{
  const p=JSON.parse(answer.trim());
  if(!Array.isArray(p.edits)||p.edits.length<1||p.edits.length>4)throw Error('Invalid edit count');
  for(const edit of p.edits){
   if(typeof edit.oldText!=='string'||!edit.oldText||typeof edit.newText!=='string'||edit.newText.length>512||candidate.split(edit.oldText).length!==2)throw Error('Edit must match exactly once');
   // This benchmark accepts local expression repairs, not arbitrary executable additions.
   if(/\b(import|require|process|Bun|globalThis|eval|Function|constructor|prototype|__proto__|console|fetch|setTimeout)\b|[\[\]{};`]/.test(edit.newText))throw Error('Edit outside expression-only repair scope');
   candidate=candidate.replace(edit.oldText,()=>edit.newText);
  }
  const context=p.evidence?.early===data.early&&p.evidence?.late===data.late&&p.evidence?.policy==='bun-only';
  const tests=await executeTests(data.task,candidate);
  return {passed:context&&tests.passed,context,tests,candidate};
 }catch(error){return {passed:false,context:false,error:String(error).slice(0,300),candidate};}
}
