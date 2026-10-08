import { runHarnessTask as runHarness } from '@zhivex-ai/harness/code-support';
import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createHarness, Workspace } from '@zhivex-ai/harness/engine';
import { CODE_TASK_KEY, prepareCodeTask, keepCodeTask, restoredCodeTask, freshCodeTaskRecap } from '../src/cli/console/console-task.js';
import { consoleWorkspaceDiff } from '../src/cli/console/console-diff.js';
import { persistHarnessTaskDraft, readHarnessTaskDraft, TASK_ACCEPTANCE_EVIDENCE_KEY, TASK_BUDGET_KEY } from '@zhivex-ai/harness/code-support';

const goal = { goal:'Fix greeting', paths:['greeting.mjs'], checks:['test'], constraints:['Preserve named export'] };
async function fixture(work: (root: string) => Promise<void>, git = true) {
  const root = await mkdtemp('/tmp/code-task-delivery-');
  try {
    await writeFile(root+'/package.json',JSON.stringify({packageManager:'npm@11.0.0',scripts:{test:'node --test greeting.test.mjs'}}));
    await writeFile(root+'/greeting.mjs','export const greeting = "before";\n');
    await writeFile(root+'/greeting.test.mjs','import assert from "node:assert/strict";import {greeting} from "./greeting.mjs";assert.equal(greeting,"after");\n');
    await writeFile(root+'/.gitignore','.zhivex-harness/\n');
    if (git) for (const args of [['init'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','baseline']]) {
      const result = spawnSync('git',args,{cwd:root,encoding:'utf8'});
      if (result.status !== 0) throw new Error(result.stderr);
    }
    await work(root);
  } finally {await rm(root,{recursive:true,force:true});}
}

test('/diff never reports a clean workspace when Git is unavailable after a real edit', async () => fixture(async root => {
  const workspace = await Workspace.open(root);
  await writeFile(root+'/greeting.mjs','edited\n');
  const text=await consoleWorkspaceDiff(workspace);
  expect(text).toContain('Git review unavailable');
  expect(text).toContain('absence of changes is not established');
  expect(text).not.toContain('No workspace changes');
},false));

test('guided task rejects dirty and missing Git baselines without changing them', async () => fixture(async root => {
  const harness=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  try {
    const task=await prepareCodeTask(harness,goal);
    expect(task.contract.allowedWritePaths).toEqual(['greeting.mjs']);
    expect(task.budgetVersion).toBe(1);
    await writeFile(root+'/greeting.mjs','user changes\n');
    await expect(prepareCodeTask(harness,goal)).rejects.toThrow('clean Git-visible');
  } finally {await harness.close();}
}));

test('unlimited chat requires an explicit task budget and retains its defaults', async () => fixture(async root => {
  const harness = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [],
    unlimitedTokens: true, modelInstance: createMockLanguageModel() });
  try {
    await expect(prepareCodeTask(harness, goal)).rejects.toThrow('TASK_BUDGET_FINITE_LIMITS_REQUIRED');
    const task = await prepareCodeTask(harness, { ...goal, budget: { inputTokens: 10000, outputTokens: 1000, totalTokens: 11000 } });
    expect(task.budgetVersion).toBe(1);
    expect(harness.config.budget.unlimitedTokens).toBe(true);
    await expect(prepareCodeTask(harness, { ...goal, budget: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } })).rejects.toThrow();
  } finally { await harness.close(); }
}));

test('guided task rejects an ignored selected file even when Git reports a clean baseline', async () => fixture(async root => {
  await writeFile(root+'/.git/info/exclude','ignored.txt\n');
  await writeFile(root+'/ignored.txt','invisible baseline\n');
  const harness=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  try {
    expect((await harness.workspace.gitDiff()).status.stdout).toBe('');
    await expect(prepareCodeTask(harness,{...goal,paths:['ignored.txt']})).rejects.toThrow('Git-tracked');
  } finally {await harness.close();}
}));

for (const flag of ['--skip-worktree', '--assume-unchanged']) test(`guided task rejects selected files hidden by ${flag}`, async () => fixture(async root => {
  expect(spawnSync('git',['update-index',flag,'greeting.mjs'],{cwd:root}).status).toBe(0);
  const harness=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  try {
    await expect(prepareCodeTask(harness,goal)).rejects.toThrow('Git-tracked');
  } finally {await harness.close();}
}));

for (const [label, content, eligible] of [
  ['121 short lines', 'x\n'.repeat(121), true],
  ['one long line', 'x'.repeat(20000), true],
  ['64 KiB including CRLF', 'x\r\n'.repeat(21845)+'x', true],
  ['64 KiB multibyte', 'é'.repeat(32768), true],
  ['one byte over 64 KiB', 'x'.repeat(65537), false],
  ['multibyte over 64 KiB', 'é'.repeat(32769), false],
] as const) test(`guided task measures raw bytes: ${label}`, async () => fixture(async root => {
  await writeFile(root+'/greeting.mjs',content);
  const committed=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-am','size fixture'],{cwd:root,encoding:'utf8'});
  expect(committed.status).toBe(0);
  const harness=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  try {
    if (eligible) {
      const task=await prepareCodeTask(harness,goal);
      expect(task.baseline['greeting.mjs']).toBe((await harness.workspace.inspectFile('greeting.mjs')).digest);
    } else await expect(prepareCodeTask(harness,goal)).rejects.toThrow('64 KiB');
  } finally {await harness.close();}
}));

test('goal, constraints and check receipts survive reopening; keep requires fresh review and rejects drift', async () => fixture(async root => {
  const probe=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  const task=await prepareCodeTask(probe,goal);
  const digest=(await probe.workspace.readFile('greeting.mjs')).digest;await probe.close();
  const harness=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel({streamEvents:[
    [{type:'tool-call',toolCall:{id:'edit',name:'apply_reviewed_edits',input:{changes:[{path:'greeting.mjs',expectedDigest:digest,content:'export const greeting = "after";\n'}]}}},{type:'finish',finishReason:'tool-calls',usage:{inputTokens:20,outputTokens:5,totalTokens:25}}],
    [{type:'tool-call',toolCall:{id:'check',name:'run_check',input:{check:'test',expectedScript:'node --test greeting.test.mjs'}}},{type:'finish',finishReason:'tool-calls',usage:{inputTokens:20,outputTokens:5,totalTokens:25}}],
    [{type:'text-delta',textDelta:'done'},{type:'finish',finishReason:'stop',usage:{inputTokens:20,outputTokens:5,totalTokens:25}}]
  ]})});
  let runId='';
  try {
    const result=await runHarness(harness,{prompt:task.goal,metadata:{[CODE_TASK_KEY]:JSON.parse(JSON.stringify(task))}},{taskAcceptance:task.contract,taskBudgetExisting:true,
      resolveApprovals:async approvals=>approvals.map(approval=>({approvalRequestId:approval.id,provider:approval.provider,approve:true}))});
    runId=result.state.runId;
  } finally {await harness.close();}
  const reopened=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  try {
    const state=(await reopened.store.load(runId,reopened.config.scope))!;
    expect(restoredCodeTask(state)).toMatchObject({goal:goal.goal,constraints:goal.constraints,budgetVersion:1});
    const {budgetVersion: _legacyBudget, ...legacyTask}=task;
    expect(restoredCodeTask({metadata:{[CODE_TASK_KEY]:JSON.parse(JSON.stringify(legacyTask))}})).toMatchObject({goal:goal.goal,constraints:goal.constraints});
    expect(await freshCodeTaskRecap(reopened,state)).toContain('task evidence: pending_review');
    expect(await freshCodeTaskRecap(reopened,state)).toContain('test: exit 0');
    expect(await freshCodeTaskRecap(reopened,state)).toContain('Confirmed: input 60; output 15; total 75');
    const staleBudget = { ...state, metadata: { ...state.metadata, [TASK_BUDGET_KEY]: {
      ...(state.metadata![TASK_BUDGET_KEY] as object), confirmed:{inputTokens:0,outputTokens:0,totalTokens:0} } } };
    expect(await freshCodeTaskRecap(reopened,staleBudget)).toContain('Confirmed: input 60; output 15; total 75');
    const conflicting = { ...state, metadata: { ...state.metadata, [TASK_ACCEPTANCE_EVIDENCE_KEY]: {
      ...(state.metadata![TASK_ACCEPTANCE_EVIDENCE_KEY] as object), contractDigest: 'sha256:'+'a'.repeat(64) } } };
    expect(await freshCodeTaskRecap(reopened,conflicting)).toContain('REQUIREMENTS CONFLICT');
    await expect(keepCodeTask(reopened,conflicting,async()=>true)).rejects.toThrow('requirements changed');
    await keepCodeTask(reopened,state,async review=>{expect(review).toContain('after');return false;});
    expect(restoredCodeTask((await reopened.store.load(runId,reopened.config.scope))!)?.keep).toBeUndefined();
    expect(spawnSync('git',['update-index','--assume-unchanged','greeting.mjs'],{cwd:root}).status).toBe(0);
    await expect(keepCodeTask(reopened,state,async()=>{throw new Error('Must not reach confirmation');})).rejects.toThrow('Git-tracked');
    expect(spawnSync('git',['update-index','--no-assume-unchanged','greeting.mjs'],{cwd:root}).status).toBe(0);
    await expect(keepCodeTask(reopened,state,async()=>{
      expect(spawnSync('git',['update-index','--assume-unchanged','greeting.mjs'],{cwd:root}).status).toBe(0);
      return true;
    })).rejects.toThrow();
    expect(restoredCodeTask((await reopened.store.load(runId,reopened.config.scope))!)?.keep).toBeUndefined();
    expect(spawnSync('git',['update-index','--no-assume-unchanged','greeting.mjs'],{cwd:root}).status).toBe(0);
    await keepCodeTask(reopened,state,async()=>true);
    const kept=(await reopened.store.load(runId,reopened.config.scope))!;
    expect(restoredCodeTask(kept)?.keep?.runId).toBe(runId);
    await expect(keepCodeTask(reopened,state,async()=>true)).rejects.toThrow();
    await writeFile(root+'/greeting.mjs','external change\n');
    expect(await freshCodeTaskRecap(reopened,kept)).toContain('STALE EVIDENCE');
    await expect(keepCodeTask(reopened,kept,async()=>true)).rejects.toThrow('stale');
  } finally {await reopened.close();}
}));

test('a refused first request preserves the established task draft and budget across restart', async () => fixture(async root => {
  let requests=0;
  const model=createMockLanguageModel();
  const harness=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],
    maxInputTokens:1,maxOutputTokens:1,maxTotalTokens:2,
    modelInstance:{...model,stream:async input=>{requests++;return model.stream!(input);}}});
  let task: Awaited<ReturnType<typeof prepareCodeTask>>;
  try {
    task=await prepareCodeTask(harness,goal);
    await persistHarnessTaskDraft(harness,'first-refused',JSON.parse(JSON.stringify(task)));
    let refusal='';
    try {
      const result=await runHarness(harness,{runId:'first-refused-run',prompt:task.goal,metadata:{[CODE_TASK_KEY]:JSON.parse(JSON.stringify(task))}},
        {taskAcceptance:task.contract,taskBudgetExisting:true,taskBudgetContinue:true});
      refusal=result.state.error?.message??'';
    } catch(error) {refusal=String(error);}
    expect(refusal).toContain('TASK_BUDGET_EXHAUSTED');
    expect(requests).toBe(0);
  } finally {await harness.close();}
  const reopened=await createHarness({workspace:root,usageAccounting:{},subagentProfiles:[],modelInstance:createMockLanguageModel()});
  try {
    const draft=await readHarnessTaskDraft(reopened.store,reopened.config.scope,'first-refused');
    const restored=restoredCodeTask({metadata:{[CODE_TASK_KEY]:JSON.parse(JSON.stringify(draft))}})!;
    expect(restored.contract.taskId).toBe(task!.contract.taskId);
    expect(restored.budgetVersion).toBe(1);
    const state={schemaVersion:1 as const,metadata:{[CODE_TASK_KEY]:JSON.parse(JSON.stringify(restored))},status:'failed' as const,
      runId:'first-refused-run',provider:'mock',modelId:'mock-model',messages:[],steps:[],toolResults:[],pendingApprovals:[],
      currentStep:0,maxSteps:1,outputText:'',updatedAt:Date.now()};
    expect(await freshCodeTaskRecap(reopened,state)).toContain('Task token limits: input 1; output 1; total 2');
  } finally {await reopened.close();}
}));

test('task recap separates durable request, native drain, provider uncertainty and acceptance', async () => fixture(async root => {
  const { codeTaskBudgetRecap } = await import('../src/cli/console/console-task.js');
  const { initializeHarnessTaskBudget, inspectHarnessTaskBudget } = await import('@zhivex-ai/harness/code-support');
  const host = await createHarness({ workspace: root, usageAccounting: {}, subagentProfiles: [], modelInstance: createMockLanguageModel() });
  try {
    await initializeHarnessTaskBudget(host, 'recap');
    const budget = await inspectHarnessTaskBudget(host, 'recap');
    for (const localExecution of ['unconfirmed', 'native_tools_drained']) {
      const text = codeTaskBudgetRecap({ ...budget, admissionsClosed: true,
        cancellations: [{ runId: 'cancelled-run', requestedAt: 1, origin: 'operator', localExecution, remoteExecution: 'unconfirmed' }] });
      expect(text).toContain('Cancellation requested for cancelled-run');
      expect(text).toContain(localExecution === 'unconfirmed' ? 'local execution unconfirmed' : 'native tool callbacks drained');
      expect(text).toContain('Provider stop unconfirmed');
      expect(text).toContain('Task acceptance remains separate');
      expect(text).toContain('Confirmed: input 0; output 0; total 0');
    }
  } finally { await host.close(); }
}));
