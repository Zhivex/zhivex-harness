import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pythonSourceProbe } from '../scripts/swebench/python-environment.js';

test('Python preflight rejects image packages shadowing the checkout for nested scripts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'python-origin-'));
 try {
  const checkout=path.join(root,'checkout'),image=path.join(root,'image');
  for(const dir of [checkout,image]){await mkdir(path.join(dir,'fixture_pkg'),{recursive:true});await writeFile(path.join(dir,'fixture_pkg/__init__.py'),"raise RuntimeError('Must not import package code')\n");}
  const run=async(pythonpath:string)=>{const p=Bun.spawn(['python3','-c',pythonSourceProbe(checkout)],{cwd:checkout,env:{PATH:process.env.PATH,PYTHONPATH:pythonpath},stdout:'pipe',stderr:'pipe'});const err=await new Response(p.stderr).text();return {exit:await p.exited,err};};
  expect((await run(checkout+':'+image)).exit).toBe(0);
  const wrong=await run(image+':'+checkout);expect(wrong.exit).not.toBe(0);expect(wrong.err).toContain('CHECKOUT_PACKAGE_SHADOWED');
  const missing=await run(image);expect(missing.exit).not.toBe(0);expect(missing.err).toContain('CHECKOUT_PYTHONPATH_MISSING');
 }finally{await rm(root,{recursive:true,force:true});}
});
