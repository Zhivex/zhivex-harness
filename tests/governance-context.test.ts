import { expect,test } from 'bun:test';
import { governanceReference,projectGovernanceEnvelopes,readGovernanceSession } from '../src/persistence/governance-context.js';
import { createChangeEnvelope } from '../src/workspace/change-envelope.js';
import type { CliSession } from '../src/persistence/sessions.js';
const sha='sha256:'+'a'.repeat(64);
const now=Date.parse('2026-09-29T12:00:00.000Z');
const session=()=>({sessionId:'session-private',revision:1,runs:[{runId:'run'}]} as CliSession);
const event=(sequence:number,runId='run')=>({sessionId:'session-private',runId,sequence,activity:{schemaVersion:1,type:'policy-decision',phase:'tool-entry',toolName:'SECRET',decision:'deny',ruleIds:['SECRET'],reason:'SECRET',reasonTruncated:false,policyDigest:sha,source:'application',approvalRequired:false,explicitReviewRequired:false,executionBackend:'oci',evidence:'policy-evaluation'}});

test('session linkage and paginated policy evidence omit arbitrary text and unrelated runs',async()=>{
 const result=await readGovernanceSession({id:'session-private',index:{get:async()=>session()},history:{replay:(_id,after)=>({schemaVersion:1,cursorExpired:false,nextCursor:after?3:1,hasMore:!after,events:after?[event(2,'unrelated'),event(3)]:[event(1)]})}},'run',new Set(['run']));
 expect(result.session).toMatchObject({availability:'recorded',revision:1});
 expect(result.history).toMatchObject({availability:'recorded',retention:'retained',incomplete:false});
 expect(result.history.policyDecisions).toHaveLength(2);
 expect(JSON.stringify(result)).not.toContain('SECRET');expect(JSON.stringify(result)).not.toContain('session-private');
 await result.verify();
});

test('expired replay stays incomplete; absent history is unknown rather than zero evidence',async()=>{
 const expired=await readGovernanceSession({id:'session-private',index:{get:async()=>session()},history:{replay:()=>({schemaVersion:1,cursorExpired:true,nextCursor:100,events:[]})}},'run',new Set(['run']));
 expect(expired.history).toMatchObject({retention:'expired',incomplete:true,policyDecisions:[]});
 const unknown=await readGovernanceSession(undefined,'run',new Set(['run']));expect(unknown.history).toMatchObject({availability:'unavailable',retention:'unknown',incomplete:true});
});

test('foreign sessions, stuck cursors and concurrent session mutation reject export',async()=>{
 await expect(readGovernanceSession({id:'other',index:{get:async()=>session()}},'run',new Set(['run']))).rejects.toThrow('SESSION_MISMATCH');
 await expect(readGovernanceSession({id:'session-private',index:{get:async()=>session()},history:{replay:()=>({schemaVersion:1,cursorExpired:false,hasMore:true,nextCursor:0,events:[]})}},'run',new Set(['run']))).rejects.toThrow('HISTORY_INVALID');
 let revision=1;
 const result=await readGovernanceSession({id:'session-private',index:{get:async()=>({...session(),revision})}},'run',new Set(['run']));revision++;
 await expect(result.verify()).rejects.toThrow('STATE_CHANGED');
});

test('envelope linkage keeps integrity, expiry, patch bytes and authenticity independent',()=>{
 const envelope=createChangeEnvelope({createdAt:'2026-09-29T10:00:00.000Z',expiresAt:'2026-09-29T11:00:00.000Z',base:{workspaceDigest:sha,treeDigest:sha},patch:{patchId:sha,patchDigest:sha},fingerprints:{harness:sha,policy:sha,environment:sha},checks:[{checkId:'test',status:'passed',redacted:true,startedAt:'2026-09-29T09:00:00.000Z',completedAt:'2026-09-29T09:00:01.000Z',durationMs:1000,exitCode:0}]});
 const references=new Map([[sha,[governanceReference('run','run')]]]);
 const value=projectGovernanceEnvelopes([envelope],references,now)[0]!;
 expect(value).toMatchObject({schemaValid:true,integrity:'valid',expiration:'expired',authenticity:'not-verified',patchBytes:'not-verified',linkedRunReferences:references.get(sha)});
 expect(projectGovernanceEnvelopes([{...envelope,envelopeId:'sha256:'+'b'.repeat(64)}],references,now)[0]!.integrity).toBe('invalid');
 expect(projectGovernanceEnvelopes([envelope],new Map(),now)[0]!.linkedRunReferences).toEqual([]);
 const invalid=projectGovernanceEnvelopes([{prompt:'SECRET'}],references,now)[0]!;
 expect(invalid).toMatchObject({schemaValid:false,integrity:'invalid',expiration:'unknown'});expect(JSON.stringify(invalid)).not.toContain('SECRET');
 expect(()=>projectGovernanceEnvelopes(Array(33).fill(envelope),references,now)).toThrow('LIMIT');
});

test('history changes between reads are detected independently of session revision',async()=>{
 let changed=false;
 const context=await readGovernanceSession({id:'session-private',index:{get:async()=>session()},history:{replay:()=>({schemaVersion:1,cursorExpired:false,nextCursor:changed?2:1,events:changed?[event(1),event(2)]:[event(1)]})}},'run',new Set(['run']));
 changed=true;await expect(context.verify()).rejects.toThrow('STATE_CHANGED');
});
