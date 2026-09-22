import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness } from '../src/runtime/harness.js';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createEditProposal } from '../src/workspace/edit-contracts.js';
import { captureRunCandidate } from '../scripts/swebench/candidate.js';
import type { HarnessOciRuntimeAdapter, HarnessExecutionSession } from '../src/execution/execution-environment.js';

test('candidate capture uses the actual run scope instead of configuration defaults',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'candidate-scope-'));let h;
 try {
  await writeFile(path.join(root,'value.txt'),'before\n');
  const runtime:HarnessOciRuntimeAdapter={async inspectImage(imageReference){return {runtime:'docker',runtimeVersion:'fixture',imageReference,imageId:`sha256:${'a'.repeat(64)}`,imageDigest:`sha256:${'a'.repeat(64)}`};},async run(){throw new Error('No subprocess expected');},async removeRunContainers(){return 0;},async cleanupOrphans(){return 0;}};
  h=await createHarness({workspace:root,executionBackend:'oci',ociRuntimeAdapter:runtime,modelInstance:createMockLanguageModel()});
  const env=h.executionEnvironment!;
  const session=await env.acquire({runId:'capture'}) as HarnessExecutionSession;
  const before=await session.workspace.readFile('value.txt');
  const changes=[{path:'value.txt',expectedDigest:before.digest,content:'after\n'}];
  await session.workspace.applyPatch({proposalId:createEditProposal({changes}).proposalId,changes});
  await session.release?.({status:'failed'});
  const wrong=await captureRunCandidate(env,{runId:'capture',scope:h.config.scope});
  expect(wrong.entries).toHaveLength(0);
  const actual=await captureRunCandidate(env,{runId:'capture'});
  expect(actual.entries).toHaveLength(1);expect(actual.entries[0]).toMatchObject({path:'value.txt',content:'after\n'});
 }finally{await h?.close();await rm(root,{recursive:true,force:true});}
});
