import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {encodeNumberedReadLines,decodeNumberedReadLines,encodeReadContent} from '../packages/core/src/context/numbered-read-lines.js';
import {decodeLosslessLines} from '../packages/core/src/context/lossless-lines.js';
import {fixture,tasks} from '../scripts/benchmarks/code-context/fixtures.js';
test('numbered encoding roundtrips non-repetitive source, indentation, blank lines and Unicode',()=>{
 for(const start of [1,98,998,123456])for(const ending of ['', '\n', '\r\n']){
  const raw=Array.from({length:180},(_,i)=>i%7===0?'':`\t  ${createHash('sha256').update(String(i)).digest('hex')} 😀\r`).join('\n')+ending;
  const numbered=raw.split('\n').map((line,i)=>`${start+i}: ${line}`).join('\n');
  const encoded=encodeNumberedReadLines(numbered);expect(encoded).toBeDefined();
  expect(decodeNumberedReadLines(encoded!)).toBe(numbered);
 }
});
test('irregular numbering and short reads stay raw; candidates never increase serialized size',()=>{
 for(const text of ['hello','1: a\n2: b',Array.from({length:30},(_,i)=>`${i}: ${i}`).join('\n'),Array.from({length:30},(_,i)=>`${i+1}: data`).join('\n').replace('19: ','18: ')])expect(encodeNumberedReadLines(text)).toBeUndefined();
 const text=Array.from({length:100},(_,i)=>`${i+1}: ${'same suffix '.repeat(30)}`).join('\n');
 const encoded=encodeReadContent(text)!;expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(text).length);
 expect(encoded.encoding==='numbered-lines-v1'?decodeNumberedReadLines(encoded):decodeLosslessLines(encoded)).toBe(text);
});
for(const name of tasks)test(`${name}: every long real source read remains exact and readable`,async()=>{
 const data=await fixture(name,6);
 for(const path of data.paths){
  const text=data.files[path]!.split('\n').map((line,i)=>`${i+1}: ${line}`).join('\n');
  const encoded=encodeReadContent(text)!;expect(encoded.encoding).toBe('numbered-lines-v1');
  expect(encoded.encoding==='numbered-lines-v1'?decodeNumberedReadLines(encoded):decodeLosslessLines(encoded)).toBe(text);
  expect(JSON.stringify(encoded)).toContain('SOURCE');
 }
});

test('restored batch reads preserve metadata, provenance and failed-read payloads',async()=>{
 const {replayCompactedReads}=await import('../packages/core/src/context/working-read-replay.js');
 const data=await fixture('path-policy',6);
 const content=data.files[data.paths[0]!]!.split('\n').map((line,i)=>`${i+1}: ${line}`).join('\n');
 const files=[{path:'a.ts',content,digest:'unchanged',truncated:false},{path:'b.ts',content:'short'}];
 const results=[{toolName:'read_files',toolCallId:'batch',output:{files},isError:false},{toolName:'read_file',toolCallId:'failed',output:{content,error:{code:'DENIED'}},isError:true},{toolName:'read_tool_result',toolCallId:'recover',output:{content},isError:false}];
 const state:any={runId:'one',compactions:[{}],toolResults:results,steps:[{response:{messages:[{role:'assistant',parts:results.map(r=>({type:'tool-call',toolCall:{id:r.toolCallId,name:r.toolName,input:{path:'a.ts'}}}))}]}}]};
 const saved=structuredClone(state);
 const replay=replayCompactedReads([],state,{read_files:{},read_file:{},read_tool_result:{}} as any);
 expect(replay.some(m=>m.role==='system')).toBe(false);
 expect(JSON.stringify(replay[0])).toContain('untrusted historical evidence');
 const outputs=replay.flatMap(m=>m.parts).flatMap(p=>p.type==='tool-result'?[p.toolResult]:[]);
 const encoded=(outputs[0]!.output as any).files;
 expect(decodeNumberedReadLines(encoded[0].content)).toBe(content);
 expect({...encoded[0],content}).toEqual(files[0]);
 expect(encoded[1]).toEqual(files[1]);
 expect(outputs.slice(1)).toEqual(results.slice(1));
 expect(state).toEqual(saved);
 expect(replayCompactedReads(replay,state,{read_files:{},read_file:{},read_tool_result:{}} as any)).toEqual(replay);
});
