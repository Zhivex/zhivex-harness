import {test,expect} from 'bun:test';
import type {AgentToolCallJournalEntry} from '@zhivex-ai/core';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {nextTaskAcceptanceLedger} from '../src/runtime/task-acceptance-record.js';
import {createTaskAcceptanceChecks} from '../src/runtime/task-acceptance-checks.js';
import {acceptanceSnapshotDigest} from '../src/execution/acceptance-snapshot.js';
const contract={schemaVersion:1,taskId:'check',allowedWritePaths:['result.txt'],protectedFiles:[],humanReview:[],requiredChecks:[
  {id:'first',kind:'argv',command:'node',args:['--test','first.js'],purpose:'First',execution:{backend:'oci',approval:'required',network:'none'}},
  {id:'second',kind:'argv',command:'node',args:['--test','second.js'],purpose:'Second',execution:{backend:'oci',approval:'required',network:'none'}}]};
const hash=(char:string)=>'sha256:'+char.repeat(64);
const binding={runId:'run',executionIdentity:'image-and-scope',patchId:hash('a'),snapshotDigest:hash('b')};
test('all required checks bind run, environment, patch, bytes and contract revision',()=>{
  const ledger=nextTaskAcceptanceLedger(undefined,contract),checks=createTaskAcceptanceChecks(ledger);
  expect(checks.missing(binding)).toEqual(['first','second']);
  checks.record('first',binding,binding,{exitCode:0,timedOut:false});
  expect(checks.missing(binding)).toEqual(['second']);
  checks.record('second',binding,binding,{exitCode:0,timedOut:false});
  expect(checks.missing(binding)).toEqual([]);
  for(const changed of [{runId:'other'},{executionIdentity:'other'},{patchId:hash('c')},{snapshotDigest:hash('d')}])expect(checks.missing({...binding,...changed})).toHaveLength(2);
  expect(createTaskAcceptanceChecks(ledger,checks.snapshot()).missing(binding)).toEqual(['first','second']);
  const revision=nextTaskAcceptanceLedger(ledger,{...contract,allowedWritePaths:['another.txt']});
  expect(createTaskAcceptanceChecks(revision,checks.snapshot()).missing(binding)).toHaveLength(2);
});
test('failure, timeout, drift or new uncertain attempt cannot satisfy checks',()=>{
  const checks=createTaskAcceptanceChecks(nextTaskAcceptanceLedger(undefined,contract));
  for(const result of [{exitCode:1,timedOut:false},{exitCode:0,timedOut:true}]) {
    checks.record('first',binding,binding,result);expect(checks.missing(binding)).toContain('first');
  }
  checks.record('first',binding,{...binding,snapshotDigest:hash('c')},{exitCode:0,timedOut:false});expect(checks.missing(binding)).toContain('first');
  checks.record('first',binding,binding,{exitCode:0,timedOut:false});
  checks.begin(['first']);expect(checks.missing(binding)).toContain('first');
  expect(checks.matching('node',['--test','second.js']).map(c=>c.id)).toEqual(['second']);
  expect(checks.matching('node',['second.js','--test'])).toEqual([]);
});
test('snapshot identity includes ignored files and rejects links and excessive bytes',async()=>{
  const root=await mkdtemp('/tmp/har-check-snapshot-');
  try {
    await writeFile(root+'/.gitignore','hidden.txt\n');await writeFile(root+'/hidden.txt','before');
    const before=await acceptanceSnapshotDigest(root,1024);
    await writeFile(root+'/hidden.txt','after');expect(await acceptanceSnapshotDigest(root,1024)).not.toBe(before);
    await expect(acceptanceSnapshotDigest(root,2)).rejects.toThrow();
    await symlink(root+'/hidden.txt',root+'/link');await expect(acceptanceSnapshotDigest(root,1024)).rejects.toThrow('UNSAFE');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('recovery reconciles exact journal result and rejects interrupted or superseded checks',()=>{
  const ledger=nextTaskAcceptanceLedger(undefined,contract),checks=createTaskAcceptanceChecks(ledger);
  const source={id:'provider-check',name:'run_environment_command'};
  checks.record('first',binding,binding,{exitCode:0,timedOut:false},source);
  const row:AgentToolCallJournalEntry={runId:'run',toolCallId:'journal-hash',providerToolCallId:source.id,toolName:source.name,
    status:'completed',idempotencyKey:'key',revision:1,startedAt:10,completedAt:20,updatedAt:20,
    input:{command:'node',args:['--test','first.js']},output:{command:['node','--test','first.js'],exitCode:0,timedOut:false}};
  const recovered=(rows:AgentToolCallJournalEntry[])=>createTaskAcceptanceChecks(ledger,checks.snapshot(),rows).missing(binding);
  expect(recovered([row])).toEqual(['second']);
  checks.record('first',binding,binding,{exitCode:0,timedOut:false},{...source,startedAt:10});
  const {startedAt:_startedAt,...withoutStartedAt}=row;
  expect(recovered([withoutStartedAt])).toEqual(['second']);
  expect(recovered([{...row,completedAt:9}])).toContain('first');
  for(const altered of [{status:'running'}, {status:'failed'}, {providerToolCallId:'another'}, {runId:'other'},
    {output:{command:['node','--version'],exitCode:0,timedOut:false}},
    {output:{command:['node','--test','first.js'],exitCode:1,timedOut:false}},
    {input:{command:'node',args:['--version']}}, {completedAt:undefined}]) {
    expect(recovered([{...row,...altered} as AgentToolCallJournalEntry])).toContain('first');
  }
  expect(recovered([row,row])).toContain('first');
  const later={...row,toolCallId:'later',providerToolCallId:'later',startedAt:30,completedAt:40,updatedAt:40};
  for(const status of ['pending','running','failed','completed'] as const)expect(recovered([row,{...later,status}])).toContain('first');
  expect(recovered([{...later,startedAt:1,completedAt:5},row])).toEqual(['second']);
  const batch={...later,toolName:'run_environment_batch',input:{commands:[row.input!]}};
  expect(recovered([row,batch])).toContain('first');
  checks.record('first',binding,binding,{exitCode:0,timedOut:false},{...source,name:'run_environment_batch'});
  expect(recovered([{...row,toolName:'run_environment_batch'}])).toContain('first');
});
