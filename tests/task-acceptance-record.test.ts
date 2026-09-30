import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { TASK_ACCEPTANCE_KEY, TASK_ACCEPTANCE_EVIDENCE_KEY, nextTaskAcceptanceLedger, persistTaskAcceptanceRevision, readTaskAcceptanceLedger, taskAcceptanceCheckpointStore } from '../src/runtime/task-acceptance-record.js';

const contract=(requirement='Review readability')=>({schemaVersion:1,taskId:'repair',allowedWritePaths:['src/a.ts'],protectedFiles:[],
  requiredChecks:[{id:'tests',kind:'argv',command:'node',args:['--test'],purpose:'Tests',execution:{backend:'oci',approval:'required',network:'none'}}],
  humanReview:[{id:'readability',requirement,status:'pending'}]});

test('revision ledger rejects identity tampering and remains bounded',()=>{
  let ledger=nextTaskAcceptanceLedger(undefined,contract());
  expect(()=>nextTaskAcceptanceLedger(ledger,contract())).toThrow('UNCHANGED');
  expect(()=>nextTaskAcceptanceLedger(ledger,{...contract(),taskId:'other'})).toThrow('IMMUTABLE');
  const tampered=structuredClone(ledger);tampered.revisions[0]!.contract.allowedWritePaths=['other.ts'];
  expect(()=>readTaskAcceptanceLedger({metadata:{[TASK_ACCEPTANCE_KEY]:JSON.parse(JSON.stringify(tampered))}})).toThrow('HISTORY_INVALID');
  for(let i=2;i<=16;i++)ledger=nextTaskAcceptanceLedger(ledger,contract('review '+i));
  expect(()=>nextTaskAcceptanceLedger(ledger,contract('overflow'))).toThrow('CAPACITY');
});

test('SQLite preserves exact revisions through checkpoints and reopening; changed requirements invalidate evidence',async()=>{
  const root=await mkdtemp('/tmp/har-acceptance-ledger-');
  const open=()=>createHarness({workspace:root,subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:[[{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop'}]]})});
  let harness=await open();
  try {
    const result=await runHarness(harness,{prompt:'fixture'});
    const initial=await harness.store.load(result.state.runId,harness.config.scope);
    expect(initial).toBeDefined();
    expect(readTaskAcceptanceLedger(initial!)).toBeUndefined();
    // Internal storage test: the future host API must preflight before this transition.
    const first=await persistTaskAcceptanceRevision(harness.store,{runId:initial!.runId,scope:harness.config.scope,expectedRunRevision:initial!.revision!,expectedContractRevision:0,requirements:contract()});
    let current=(await harness.store.load(initial!.runId,harness.config.scope))!;
    const checkpoint=taskAcceptanceCheckpointStore(harness.store,current.runId,first);
    await checkpoint.save({...current,messages:[],metadata:{...current.metadata,[TASK_ACCEPTANCE_KEY]:{forged:true},
      [TASK_ACCEPTANCE_EVIDENCE_KEY]:{schemaVersion:1,status:'passed',checks:[{exitCode:0}]}}},{expectedRevision:current.revision!});
    current=(await harness.store.load(current.runId,harness.config.scope))!;
    expect(readTaskAcceptanceLedger(current)).toEqual(first);
    const second=await persistTaskAcceptanceRevision(harness.store,{runId:current.runId,scope:harness.config.scope,expectedRunRevision:current.revision!,expectedContractRevision:1,requirements:contract('Review revised behavior')});
    expect(second.revisions[1]?.previousDigest).toBe(first.revisions[0]?.digest);
    await expect(persistTaskAcceptanceRevision(harness.store,{runId:current.runId,scope:harness.config.scope,expectedRunRevision:current.revision!,expectedContractRevision:1,requirements:contract('Stale edit')})).rejects.toThrow('REVISION_CONFLICT');
    const runId=current.runId;
    await harness.close();harness=await open();
    const restored=(await harness.store.load(runId,harness.config.scope))!;
    expect(readTaskAcceptanceLedger(restored)).toEqual(second);
    expect(restored.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({contractRevision:2,contractDigest:second.revisions[1]!.digest,status:'pending',checks:[],humanReview:[{status:'pending'}]});
    const outcomes=await Promise.allSettled(['one','two'].map(requirement=>persistTaskAcceptanceRevision(harness.store,{runId,scope:harness.config.scope,expectedRunRevision:restored.revision!,expectedContractRevision:2,requirements:contract(requirement)})));
    expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
    expect(readTaskAcceptanceLedger((await harness.store.load(runId,harness.config.scope))!)?.revisions).toHaveLength(3);
  } finally {await harness.close();await rm(root,{recursive:true,force:true});}
});
