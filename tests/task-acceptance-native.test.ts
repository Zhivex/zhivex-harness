import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import type { StreamEvent } from '@zhivex-ai/core';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { taskAcceptanceContractSchema } from '../src/runtime/task-acceptance.js';
import { TASK_ACCEPTANCE_EVIDENCE_KEY } from '../src/runtime/task-acceptance-record.js';
import { nativeTaskSnapshot } from '../src/runtime/task-acceptance-native.js';
import { nextTaskAcceptanceLedger } from '../src/runtime/task-acceptance-record.js';
import { checkEvidence } from '../src/client/check-evidence.js';

const done: StreamEvent[] = [{ type:'text-delta',textDelta:'done' },{ type:'finish',finishReason:'stop' }];
const call = (name: string, input: any, id = name): StreamEvent[] => [{ type:'tool-call',toolCall:{ id,name,input } },{ type:'finish',finishReason:'tool-calls' }];
const contract = () => taskAcceptanceContractSchema.parse({ schemaVersion:1,taskId:'native',allowedWritePaths:['value.txt'],protectedFiles:['package.json'],
  requiredChecks:[{ id:'test',kind:'package-script',script:'test',expectedScript:'node -e "process.exit(0)"',command:'npm',args:['--ignore-scripts','run','test'],purpose:'fixture',execution:{backend:'none',approval:'required'} }],
  humanReview:[{ id:'human',requirement:'Review behavior',status:'pending' }] });

function packageCheck(value: ReturnType<typeof contract>) { const check=value.requiredChecks[0]!; if (check.kind !== 'package-script') throw new Error('fixture package check expected'); return check; }

async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp('/tmp/har-native-task-');
  try { await writeFile(root+'/package.json', JSON.stringify({ packageManager:'npm@11.0.0',scripts:{test:'node -e "process.exit(0)"'} })); await writeFile(root+'/value.txt','before'); await work(root); }
  finally { await rm(root,{recursive:true,force:true}); }
}

test('approved native check produces durable evidence, separately from run completion and human review', async () => fixture(async root => {
  const harness = await createHarness({ workspace:root,subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:[call('run_check',{check:'test',expectedScript:packageCheck(contract()).expectedScript}),done]}) });
  try {
    const result = await runHarness(harness,{runId:'native-checked',prompt:'check'},{taskAcceptance:contract(),resolveApprovals:async approvals=>approvals.map(item=>({approvalRequestId:item.id,provider:item.provider,approve:true}))});
    expect(result.status).toBe('completed');
    const state = await harness.store.load(result.state.runId,harness.config.scope);
    expect(state?.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({status:'pending_review',checks:[{exitCode:0,timedOut:false,unchanged:true}]});
    expect(checkEvidence(result.toolResults)).toMatchObject({passed:1,failed:0,taskVerified:false});
    await writeFile(root+'/value.txt','external edit');
    const binding = await nativeTaskSnapshot(harness.workspace,nextTaskAcceptanceLedger(undefined,contract()),result.state.runId);
    expect(binding.snapshotDigest).not.toBe((state?.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY] as any).delivery.snapshotDigest);
  } finally { await harness.close(); }
}));

test('a later edit invalidates an earlier passing check; missing and failed checks stay incomplete', async () => fixture(async root => {
  for (const scenario of ['missing','after-edit','failed'] as const) {
    await writeFile(root+'/value.txt','before');
    const required = contract();
    if (scenario === 'failed') { packageCheck(required).expectedScript='node -e "process.exit(1)"'; await writeFile(root+'/package.json',JSON.stringify({packageManager:'npm@11.0.0',scripts:{test:packageCheck(required).expectedScript}})); }
    const probe = await createHarness({workspace:root,subagentProfiles:[],modelInstance:createMockLanguageModel()});
    const digest = (await probe.workspace.readFile('value.txt')).digest; await probe.close();
    const events = scenario === 'missing' ? [done] : [call('run_check',{check:'test',expectedScript:packageCheck(required).expectedScript}),
      ...(scenario === 'after-edit' ? [call('apply_reviewed_edits',{changes:[{path:'value.txt',expectedDigest:digest,content:'after'}]})] : []),done];
    const harness = await createHarness({workspace:root,subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:events})});
    try {
      const result=await runHarness(harness,{prompt:'fixture'},{taskAcceptance:required,resolveApprovals:async approvals=>approvals.map(item=>({approvalRequestId:item.id,provider:item.provider,approve:true}))});
      expect(result.status).toBe('completed');
      expect(result.state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({status:'incomplete',reason:'TASK_ACCEPTANCE_CHECKS_MISSING'});
    } finally {await harness.close();}
  }
}));

test('native task blocks out-of-scope writes before effect and undeclared checks', async () => fixture(async root => {
  const harness=await createHarness({workspace:root,subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:[
    call('apply_reviewed_edits',{changes:[{path:'outside.txt',expectedDigest:null,content:'unsafe'}]}),
    call('run_check',{check:'build',expectedScript:'node -e "process.exit(0)"'}),done]})});
  try {
    const result=await runHarness(harness,{prompt:'fixture'},{taskAcceptance:contract(),resolveApprovals:async approvals=>approvals.map(item=>({approvalRequestId:item.id,provider:item.provider,approve:true}))});
    expect(result.toolResults.filter(item=>item.isError)).toHaveLength(2);
    await expect(readFile(root+'/outside.txt')).rejects.toThrow();
    expect(result.state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]).toMatchObject({status:'incomplete'});
  } finally {await harness.close();}
}));

test('safe check projection does not disclose command text or command output', () => {
  const evidence=checkEvidence([{toolName:'run_check',output:{command:['npm','secret'],stdout:'TOKEN=secret',stderr:'password',exitCode:1,timedOut:false}}]);
  expect(evidence).toMatchObject({passed:0,failed:1,taskVerified:false});
  expect(JSON.stringify(evidence)).not.toContain('secret');
  expect(JSON.stringify(evidence)).not.toContain('password');
});
