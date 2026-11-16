import {test,expect} from 'bun:test';
import {fixture,tasks} from '../scripts/benchmarks/code-context/fixtures.js';
import {grade} from '../scripts/benchmarks/code-context/grade.js';
for(const task of tasks)for(const size of [4,6] as const)test(`${task}: real source context ${size} files fits complete bounded reads`,async()=>{
 const data=await fixture(task,size);
 expect(data.original).not.toBe(data.buggy);
 expect(data.paths).toHaveLength(size);
 expect(data.files[data.paths[0]!]!).toContain(data.early);
 expect(data.files[data.paths.at(-1)!]!).toContain(data.late);
 for(const p of data.paths){
  const text=data.files[p]!;
  expect(text.split('\n').map((l,i)=>`${i+1}: ${l}`).join('\n').length).toBeLessThan(16000);
  expect(data.context[p]!.losslessEligible).toBe(false);
  expect(text).toContain('SOURCE');
 }
 const repeat=await fixture(task,size);expect(repeat.hash).toBe(data.hash);
});
test('patch acceptance rejects broad matches, commands and structural rewrites before execution',async()=>{
 const data=await fixture('path-policy',4);
 for(const edits of [[],[{oldText:'not-present',newText:'x'}],[{oldText:'name.toLocaleLowerCase("tr")',newText:'process.exit()'}],[{oldText:'name.toLocaleLowerCase("tr")',newText:'(()=>{return 1})()'}]]){
  const result=await grade(data,JSON.stringify({edits,evidence:{early:data.early,late:data.late,policy:'bun-only'}}));
  expect(result.passed).toBe(false);expect(result).not.toHaveProperty('tests');
 }
});
