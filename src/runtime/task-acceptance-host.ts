import type { AgentRunInput, LanguageModel, ToolSet } from '@zhivex-ai/core';
import { serializeJsonValue } from '@zhivex-ai/core';
import type { ZhivexHarness } from './harness.js';
import type { HarnessConfig } from './config.js';
import type { HarnessToolPolicy } from './tool-policy.js';
import type { TaskAcceptanceContract } from './task-acceptance.js';
import { validateTaskAcceptanceWorkspace } from './task-acceptance-validation.js';
import { withTaskAcceptanceDelivery } from './task-acceptance-delivery.js';
import { TASK_ACCEPTANCE_KEY, TASK_ACCEPTANCE_EVIDENCE_KEY, readTaskAcceptanceLedger, nextTaskAcceptanceLedger, persistTaskAcceptanceRevision, type TaskAcceptanceLedger } from './task-acceptance-record.js';

const hosts=new WeakMap<object,{config:HarnessConfig;tools:ToolSet;policy?:HarnessToolPolicy}>();
const active=new Set<string>();
export function bindTaskAcceptanceHost(host:object,context:{config:HarnessConfig;tools:ToolSet;policy?:HarnessToolPolicy}) {
  if(hosts.has(host)) throw new Error('TASK_ACCEPTANCE_HOST_ALREADY_BOUND');
  hosts.set(host,{config:structuredClone(context.config),tools:{...context.tools},...(context.policy?{policy:structuredClone(context.policy)}:{})});
}
const contextFor=(host:object)=>{const context=hosts.get(host);if(!context)throw new Error('TASK_ACCEPTANCE_HOST_UNAVAILABLE');return context;};
const keyFor=(host:ZhivexHarness,runId:string)=>JSON.stringify([contextFor(host).config.stateDirectory,contextFor(host).config.workspace,contextFor(host).config.scope,runId]);

export async function inspectHarnessTaskAcceptance(host:ZhivexHarness,runId:string):Promise<TaskAcceptanceLedger|undefined> {
  const state=await host.store.load(runId,contextFor(host).config.scope);
  if(!state)throw new Error('TASK_ACCEPTANCE_RUN_NOT_FOUND');
  return readTaskAcceptanceLedger(state);
}

/** Application API: revising requirements never grants approval or claims that checks passed. */
export async function reviseHarnessTaskAcceptance(host:ZhivexHarness,request:{runId:string;expectedRunRevision:number;expectedContractRevision:number;contract:TaskAcceptanceContract}):Promise<TaskAcceptanceLedger> {
  const context=contextFor(host),key=keyFor(host,request.runId);
  if(active.has(key))throw new Error('TASK_ACCEPTANCE_RUN_ACTIVE');
  active.add(key);
  try {
    const state=await host.store.load(request.runId,context.config.scope);
    if(!state || state.revision!==request.expectedRunRevision)throw new Error('TASK_ACCEPTANCE_REVISION_CONFLICT');
    if(!['waiting_approval','completed','failed','cancelled','timed_out'].includes(state.status))throw new Error('TASK_ACCEPTANCE_RUN_ACTIVE');
    if(!readTaskAcceptanceLedger(state))throw new Error('TASK_ACCEPTANCE_CONTRACT_MISSING');
    const validated=await validateTaskAcceptanceWorkspace(request.contract,context);
    return persistTaskAcceptanceRevision(host.store,{runId:request.runId,scope:context.config.scope,expectedRunRevision:request.expectedRunRevision,
      expectedContractRevision:request.expectedContractRevision,requirements:validated.contract});
  } finally {active.delete(key);}
}

export async function withTaskAcceptanceRun<T>(host:ZhivexHarness,input:AgentRunInput<LanguageModel>,requirements:TaskAcceptanceContract|undefined,
  work:(input:AgentRunInput<LanguageModel>,ledger?:TaskAcceptanceLedger)=>Promise<T>):Promise<T> {
  const inputMetadata='metadata'in input ? input.metadata : undefined;
  if(inputMetadata?.[TASK_ACCEPTANCE_KEY]!==undefined || inputMetadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]!==undefined)throw new Error('TASK_ACCEPTANCE_RESERVED_METADATA');
  if('state'in input && requirements!==undefined)throw new Error('TASK_ACCEPTANCE_USE_REVISION_API');
  let ledger:TaskAcceptanceLedger|undefined;
  if('state'in input) {
    const durable=await host.store.load(input.state.runId,input.state.scope??host.config.scope);
    const stored=durable?readTaskAcceptanceLedger(durable):undefined;
    const supplied=readTaskAcceptanceLedger(input.state);
    if(stored || supplied) {
      if(!durable || durable.revision!==input.state.revision || JSON.stringify(stored)!==JSON.stringify(supplied))throw new Error('TASK_ACCEPTANCE_REVISION_CONFLICT');
      ledger=stored;
      const metadata:NonNullable<import('@zhivex-ai/core').AgentRunState['metadata']>={...input.state.metadata,[TASK_ACCEPTANCE_KEY]:durable.metadata![TASK_ACCEPTANCE_KEY]!};
      delete metadata[TASK_ACCEPTANCE_EVIDENCE_KEY];
      if(durable.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]!==undefined)metadata[TASK_ACCEPTANCE_EVIDENCE_KEY]=durable.metadata[TASK_ACCEPTANCE_EVIDENCE_KEY]!;
      input={...input,state:{...input.state,metadata}};
    }
  }
  if(!ledger && requirements===undefined)return work(input);
  const context=contextFor(host),runId='state'in input?input.state.runId:input.runId;
  const scope='state'in input?input.state.scope:input.scope;
  if(scope && ['tenantId','userId','namespace'].some(field=>scope[field as keyof typeof scope]!==context.config.scope[field as keyof typeof scope]))throw new Error('TASK_ACCEPTANCE_SCOPE_MISMATCH');
  if(!runId)throw new Error('TASK_ACCEPTANCE_RUN_ID_REQUIRED');
  const key=keyFor(host,runId);
  if(active.has(key))throw new Error('TASK_ACCEPTANCE_RUN_ACTIVE');
  active.add(key);
  try {
    const validated=await validateTaskAcceptanceWorkspace(ledger?.revisions.at(-1)?.contract??requirements,context);
    ledger??=nextTaskAcceptanceLedger(undefined,validated.contract);
    if(!('state'in input))input={...input,metadata:{...input.metadata,[TASK_ACCEPTANCE_KEY]:serializeJsonValue(ledger)}};
    return await (context.config.execution.backend==='oci'
      ? withTaskAcceptanceDelivery(host.workspace.root,ledger,()=>work(input,ledger),'state'in input?input.state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY]:undefined,
        'state'in input?await host.store.listToolCalls?.(runId,context.config.scope)??[]:[])
      : work(input,ledger));
  } finally {active.delete(key);}
}
