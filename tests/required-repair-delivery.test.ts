import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createHarness, runHarness } from '../src/runtime/harness.js';
import { createRepairController, REPAIR_CONTROLLER_KEY } from '../src/runtime/repair-controller.js';

test('required delivery persists without a plan and cannot be disabled by restoring with defaults', () => {
 const c=createRepairController({},true,{requireVerifiedDelivery:true});
 expect(c.completionPending()).toBe(true);
 expect(c.closure()).toBe(false);
 const restored=createRepairController({[REPAIR_CONTROLLER_KEY]:c.snapshot()},true);
 expect(restored.completionPending()).toBe(true);
 restored.state.phase='delivered';
 expect(restored.completionPending()).toBe(false);
});
for(const required of [false,true])test(`exploration-only final answer with required delivery=${required}`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'required-repair-'));let harness;
 try{
  const store=createInMemoryAgentRunStore();
  harness=await createHarness({workspace:root,agentProfile:'repair',requireVerifiedDelivery:required,store,
   modelInstance:createMockLanguageModel({streamEvents:Array.from({length:2},()=>[
    {type:'text-delta' as const,textDelta:'Done without repair'},
    {type:'finish' as const,finishReason:'stop' as const,usage:{inputTokens:12,outputTokens:8}}
   ])})});
  const result=await runHarness(harness,{prompt:required?'Implement the repair.':'Inspect only.'});
  expect(result.status).toBe(required?'failed':'completed');
  const saved=await store.load(result.state.runId);
  expect(saved?.status).toBe(result.status);
  if(required){expect(saved?.metadata?.[REPAIR_CONTROLLER_KEY]).toMatchObject({requireVerifiedDelivery:true,completionReminders:1});expect(result.state.error?.message).toContain('REPAIR_INCOMPLETE');}
 }finally{await harness?.close();await rm(root,{recursive:true,force:true});}
});
test('delivery policy is explicit, validated and bound to durable run identity',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'required-repair-binding-'));
 const instances:Awaited<ReturnType<typeof createHarness>>[]=[];
 try{
  await expect(createHarness({workspace:root,agentProfile:'strict',requireVerifiedDelivery:true,modelInstance:createMockLanguageModel()})).rejects.toThrow('requires agentProfile repair');
  await expect(createHarness({workspace:root,agentProfile:'repair',requireVerifiedDelivery:'true' as unknown as boolean,modelInstance:createMockLanguageModel()})).rejects.toThrow('must be boolean');
  for(const requireVerifiedDelivery of [false,true])instances.push(await createHarness({workspace:root,agentProfile:'repair',requireVerifiedDelivery,modelInstance:createMockLanguageModel(),store:createInMemoryAgentRunStore()}));
  expect(instances[0]!.agent.harness?.fingerprint).not.toBe(instances[1]!.agent.harness?.fingerprint);
 }finally{for(const h of instances)await h.close();await rm(root,{recursive:true,force:true});}
});
