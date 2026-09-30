import {test,expect} from 'bun:test';
import {nextTaskAcceptanceLedger} from '../src/runtime/task-acceptance-record.js';
import {withTaskAcceptanceDelivery,assertTaskAcceptanceImport,taskAcceptanceDeliveryDiagnostic,confirmTaskAcceptanceImport,taskAcceptanceOutcome,taskAcceptanceChecks} from '../src/runtime/task-acceptance-delivery.js';
test('persisted scope rejection survives a new observation context only for the same contract revision',async()=>{
  const contract={schemaVersion:1,taskId:'edit',allowedWritePaths:['allowed.txt'],protectedFiles:[],requiredChecks:[{id:'test',kind:'argv',command:'node',args:['--test'],purpose:'Test',execution:{backend:'oci',approval:'required',network:'none'}}],humanReview:[]};
  const ledger=nextTaskAcceptanceLedger(undefined,contract),current=ledger.revisions[0]!;
  let diagnostic:ReturnType<typeof taskAcceptanceDeliveryDiagnostic>;
  await withTaskAcceptanceDelivery('/workspace',ledger,async()=>{
    expect(()=>assertTaskAcceptanceImport({workspace:'/workspace',runId:'run',patchId:'sha256:'+'a'.repeat(64),entries:[{path:'other.txt',operation:'create'}]})).toThrow('SCOPE_VIOLATION');
    diagnostic=taskAcceptanceDeliveryDiagnostic(current.digest,current.revision);
  });
  const evidence={contractDigest:current.digest,contractRevision:1,diagnostic};
  await withTaskAcceptanceDelivery('/workspace',ledger,async()=>{
    expect(taskAcceptanceDeliveryDiagnostic(current.digest,1)).toEqual(diagnostic);
  },evidence);
  const revised=nextTaskAcceptanceLedger(ledger,{...contract,allowedWritePaths:['other.txt']});
  await withTaskAcceptanceDelivery('/workspace',revised,async()=>{
    expect(taskAcceptanceDeliveryDiagnostic(revised.revisions[1]!.digest,2)).toBeUndefined();
  },evidence);
});

test('acceptance is additive and never accepts prose, missing checks, interrupted runs or pending human review',async()=>{
  const contract={schemaVersion:1,taskId:'edit',allowedWritePaths:['allowed.txt'],protectedFiles:[],requiredChecks:[{id:'test',kind:'argv',command:'node',args:['--test'],purpose:'Test',execution:{backend:'oci',approval:'required',network:'none'}}],humanReview:[]};
  const binding={runId:'run',executionIdentity:'oci',patchId:'sha256:'+'a'.repeat(64),snapshotDigest:'sha256:'+'b'.repeat(64)};
  const terminal={runId:'run',status:'completed' as const,finishReason:'stop' as const};
  for(const review of [false,true]) {
    const ledger=nextTaskAcceptanceLedger(undefined,{...contract,humanReview:review?[{id:'review',requirement:'Review behavior',status:'pending'}]:[]});
    await withTaskAcceptanceDelivery('/workspace',ledger,async()=>{
      expect(await taskAcceptanceOutcome(terminal,ledger)).toMatchObject({status:'incomplete',reason:'TASK_ACCEPTANCE_IMPORT_UNCONFIRMED'});
      confirmTaskAcceptanceImport(binding,async()=>true);
      expect(await taskAcceptanceOutcome(terminal,ledger)).toMatchObject({status:'incomplete',reason:'TASK_ACCEPTANCE_CHECKS_MISSING'});
      taskAcceptanceChecks()!.record('test',binding,binding,{exitCode:0,timedOut:false});
      expect(await taskAcceptanceOutcome(terminal,ledger)).toMatchObject({status:review?'pending_review':'verified'});
      for(const status of ['failed','cancelled','timed_out','waiting_approval'] as const) {
        expect((await taskAcceptanceOutcome({...terminal,status},ledger)).status).not.toBe('verified');
      }
      expect(await taskAcceptanceOutcome({...terminal,finishReason:'length'},ledger)).toMatchObject({status:'incomplete'});
      expect(await taskAcceptanceOutcome({...terminal,runId:'parent'},ledger)).toMatchObject({status:'incomplete'});
      confirmTaskAcceptanceImport(binding,async()=>{throw new Error('unreadable');});
      expect(await taskAcceptanceOutcome(terminal,ledger)).toMatchObject({status:'incomplete',reason:'TASK_ACCEPTANCE_DELIVERY_INSPECTION_FAILED'});
    });
    // Reopening metadata alone cannot promote a previously verified delivery.
    await withTaskAcceptanceDelivery('/workspace',ledger,async()=>{
      expect((await taskAcceptanceOutcome(terminal,ledger)).status).toBe('incomplete');
    },{status:'verified',delivery:binding});
  }
});
