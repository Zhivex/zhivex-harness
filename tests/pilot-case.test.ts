import {expect,test} from 'bun:test';
import type {JsonValue,GenerateResult,StreamEvent} from '@zhivex-ai/core';
import {createHash} from 'node:crypto';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import * as api from '../src/engine/index.js';
import {ACCEPTANCE_FIXTURES} from '../scripts/acceptance/fixtures.js';
import {runPilotCase} from '../scripts/acceptance/pilot-case.js';
const mock=(responses:GenerateResult[])=>createMockLanguageModel({streamEvents:responses.map(r=>[...(r.messages??[]).flatMap(m=>m.parts).flatMap((p):StreamEvent[]=>p.type==='tool-call'?[{type:'tool-call',toolCall:p.toolCall}]:p.type==='text'?[{type:'text-delta',textDelta:p.text}]:[]),{type:'finish',finishReason:r.finishReason!,usage:r.usage!}])});
const usage={inputTokens:10,outputTokens:5};
const fixture=(id:string)=>ACCEPTANCE_FIXTURES.find(f=>f.id===id)!;
const call=(name:string,input:JsonValue,id=name)=>({messages:[{role:'assistant' as const,parts:[{type:'tool-call' as const,toolCall:{id,name,input}}]}],finishReason:'tool-calls' as const,usage});
const done={text:'done',messages:[{role:'assistant' as const,parts:[{type:'text' as const,text:'done'}]}],finishReason:'stop' as const,usage};
const content='export function cents(amount) { return Math.round(Number(`${amount}e2`)); }\n';
const write=(file='src/money.js')=>call('write_file',{path:file,content,expectedDigest:'sha256:'+createHash('sha256').update(fixture('bug').files['src/money.js']!).digest('hex')});
const check=(id:string)=>call('run_check',{check:'test',expectedScript:'bun verify.mjs'},id);
test('reference adapter is scored by the independent oracle and records the failed check',async()=>{
 const model=mock([check('before'),write(),check('after'),done]);
 const row=await runPilotCase(api,'sdk-reference',fixture('failed-check'),model,'fixture-model',error=>{throw error;});
 expect(row).toMatchObject({status:'passed',initialTestsFailed:true,independentTestsPassed:true,protectedFilesUnchanged:true,failedCheck:true,automatedApprovals:3,steps:4,inputTokens:40,outputTokens:20,usageComplete:true});
});
test.each(['cancellation','compaction-restart'])('reference exercises %s from persisted approval state',async id=>{
 const row=await runPilotCase(api,'sdk-reference',fixture(id),mock([write(),done]),'fixture-model',error=>{throw error;});
 expect(row.status).toBe('passed');expect(row.protectedFilesUnchanged).toBe(true);
 if(id==='compaction-restart'){expect(row.reopened).toBe(true);expect(row.compactions).toBeGreaterThan(0);}else expect(row.automatedApprovals).toBe(0);
});
test('protected-file requests fail the common approval policy before mutation',async()=>{
 const row=await runPilotCase(api,'sdk-reference',fixture('bug'),mock([write('verify.mjs'),done]),'fixture-model');
 expect(row).toMatchObject({status:'failed',protectedFilesUnchanged:true,automatedApprovals:0});
});
test('completion prose does not pass without the governed operation and oracle',async()=>{
 const row=await runPilotCase(api,'sdk-reference',fixture('bug'),mock([done]),'fixture-model');
 expect(row.status).toBe('failed');expect(row.independentTestsPassed).toBe(false);
});

test('Harness adapter uses the same oracle and observed case budget',async()=>{
 const changes=[{path:'src/money.js',content,expectedDigest:'sha256:'+createHash('sha256').update(fixture('bug').files['src/money.js']!).digest('hex')}];
 const row=await runPilotCase(api,'harness',fixture('approval'),mock([call('apply_reviewed_edits',{changes}),done]),'fixture-model',error=>{throw error;});
 expect(row).toMatchObject({status:'passed',independentTestsPassed:true,protectedFilesUnchanged:true,automatedApprovals:1,steps:2,inputTokens:20,outputTokens:10});
});
test('a user correction has cumulative consumption across both logical runs',async()=>{
 const symmetric='export function cents(amount) { return Math.sign(amount)*Math.round(Number(`${Math.abs(amount)}e2`)); }\n';
 const corrected=call('write_file',{path:'src/money.js',content:symmetric,expectedDigest:'sha256:'+createHash('sha256').update(content).digest('hex')},'correction');
 const row=await runPilotCase(api,'sdk-reference',fixture('user-correction'),mock([write(),done,corrected,done]),'fixture-model',error=>{throw error;});
 expect(row).toMatchObject({status:'passed',scriptedUserCorrections:1,steps:4,inputTokens:40,outputTokens:20,automatedApprovals:2});
});

test('restart preserves a multi-call approval group through forced compaction',async()=>{
 const first=call('read_file',{path:'src/money.js'},'read');
 first.messages[0]!.parts.push(...check('before').messages[0]!.parts);
 const row=await runPilotCase(api,'sdk-reference',fixture('compaction-restart'),mock([first,write(),check('after'),done]),'fixture-model',error=>{throw error;});
 expect(row).toMatchObject({status:'passed',reopened:true,independentTestsPassed:true,protectedFilesUnchanged:true,automatedApprovals:3});
 expect(row.compactions).toBeGreaterThan(0);
});
