import { z } from 'zod';
import { serializeJsonValue, type AgentRunState, type AgentRunStore, type AgentStoreScope } from '@zhivex-ai/core';
import { compileTaskAcceptanceContract, taskAcceptanceContractSchema } from './task-acceptance.js';
import { taskAcceptanceDeliveryDiagnostic, taskAcceptanceChecks, taskAcceptanceOutcome } from './task-acceptance-delivery.js';
import { taskCheckReceiptSchema } from './task-acceptance-checks.js';

export const TASK_ACCEPTANCE_KEY = 'zhivexTaskAcceptanceV1';
export const TASK_ACCEPTANCE_EVIDENCE_KEY = 'zhivexTaskAcceptanceEvidenceV1';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revisionSchema = z.strictObject({ revision:z.number().int().min(1), digest, previousDigest:digest.nullable(), contract:taskAcceptanceContractSchema });
const ledgerSchema = z.strictObject({ schemaVersion:z.literal(1), revisions:z.array(revisionSchema).min(1).max(16) });
export type TaskAcceptanceLedger = z.infer<typeof ledgerSchema>;

export function readTaskAcceptanceLedger(state: Pick<AgentRunState,'metadata'>): TaskAcceptanceLedger | undefined {
  const raw=state.metadata?.[TASK_ACCEPTANCE_KEY];
  if(raw===undefined) return undefined;
  if(Buffer.byteLength(JSON.stringify(raw))>1024*1024) throw new Error('TASK_ACCEPTANCE_HISTORY_CAPACITY');
  const ledger=ledgerSchema.parse(raw);
  for(let index=0;index<ledger.revisions.length;index++) {
    const row=ledger.revisions[index]!;
    if(row.revision!==index+1 || row.previousDigest!==(ledger.revisions[index-1]?.digest??null) ||
      compileTaskAcceptanceContract(row.contract).digest!==row.digest || row.contract.taskId!==ledger.revisions[0]!.contract.taskId) {
      throw new Error('TASK_ACCEPTANCE_HISTORY_INVALID');
    }
  }
  return ledger;
}

/** Internal host-only transition. The caller must preflight the new requirements. */
export function nextTaskAcceptanceLedger(current: TaskAcceptanceLedger | undefined, requirements: unknown): TaskAcceptanceLedger {
  if(current) current=readTaskAcceptanceLedger({metadata:{[TASK_ACCEPTANCE_KEY]:serializeJsonValue(current)}})!;
  const {contract,digest}=compileTaskAcceptanceContract(requirements);
  const previous=current?.revisions.at(-1);
  if(previous && previous.contract.taskId!==contract.taskId) throw new Error('TASK_ACCEPTANCE_TASK_ID_IMMUTABLE');
  if(previous?.digest===digest) throw new Error('TASK_ACCEPTANCE_UNCHANGED');
  if((current?.revisions.length??0)>=16) throw new Error('TASK_ACCEPTANCE_HISTORY_CAPACITY');
  const next:TaskAcceptanceLedger={schemaVersion:1,revisions:[...structuredClone(current?.revisions??[]),{
    revision:(previous?.revision??0)+1,previousDigest:previous?.digest??null,digest,contract
  }]};
  if(Buffer.byteLength(JSON.stringify(next))>1024*1024) throw new Error('TASK_ACCEPTANCE_HISTORY_CAPACITY');
  return next;
}

/** CAS on the authoritative run; stale operator views never overwrite another revision. */
export async function persistTaskAcceptanceRevision(store: AgentRunStore, options: {
  runId:string; scope?:AgentStoreScope; expectedRunRevision:number; expectedContractRevision:number; requirements:unknown;
}) {
  const state=await store.load(options.runId,options.scope);
  if(!state || state.revision!==options.expectedRunRevision) throw new Error('TASK_ACCEPTANCE_REVISION_CONFLICT');
  const current=readTaskAcceptanceLedger(state);
  if((current?.revisions.at(-1)?.revision??0)!==options.expectedContractRevision) throw new Error('TASK_ACCEPTANCE_REVISION_CONFLICT');
  const ledger=nextTaskAcceptanceLedger(current,options.requirements), latest=ledger.revisions.at(-1)!;
  const prior = current?.revisions.at(-1);
  const oldEvidence = state.metadata?.[TASK_ACCEPTANCE_EVIDENCE_KEY] as { checks?: unknown; delivery?: unknown } | undefined;
  const sameFiles = prior && JSON.stringify([prior.contract.allowedWritePaths, prior.contract.protectedFiles]) === JSON.stringify([latest.contract.allowedWritePaths, latest.contract.protectedFiles]);
  const previousChecks = z.array(taskCheckReceiptSchema).max(32).safeParse(oldEvidence?.checks);
  // Requirement-only changes do not erase unrelated observed checks. Their
  // original journal and current workspace must still validate during reuse.
  const checks = sameFiles && previousChecks.success ? previousChecks.data.filter(receipt =>
    receipt.contractDigest === prior.digest && receipt.contractRevision === prior.revision &&
    JSON.stringify(prior.contract.requiredChecks.find(check => check.id === receipt.checkId)) ===
    JSON.stringify(latest.contract.requiredChecks.find(check => check.id === receipt.checkId)))
    .map(receipt => ({ ...receipt, contractDigest: latest.digest, contractRevision: latest.revision })) : [];
  await store.save({...state,metadata:{...state.metadata,
    [TASK_ACCEPTANCE_KEY]:serializeJsonValue(ledger),
    [TASK_ACCEPTANCE_EVIDENCE_KEY]:serializeJsonValue({schemaVersion:1,contractRevision:latest.revision,contractDigest:latest.digest,status:'pending',checks,humanReview:latest.contract.humanReview,
      ...(sameFiles && oldEvidence?.delivery ? { delivery: oldEvidence.delivery } : {})})
  }},{expectedRevision:options.expectedRunRevision});
  return structuredClone(ledger);
}

/** Preserve host requirements through SDK checkpoints/compaction, independently of mutable model context. */
export function taskAcceptanceCheckpointStore(store:AgentRunStore,runId:string,ledger:TaskAcceptanceLedger):AgentRunStore {
  const retained=serializeJsonValue(structuredClone(ledger));
  const latest=ledger.revisions.at(-1)!;
  const pending={schemaVersion:1,contractRevision:latest.revision,contractDigest:latest.digest,status:'pending',checks:[],humanReview:serializeJsonValue(latest.contract.humanReview)};
  return new Proxy(store,{get(target,key){
    if(key==='save') return async (...args:Parameters<AgentRunStore['save']>)=>{
      const [state]=args;
      if(state.runId===runId) {
        const violation=taskAcceptanceDeliveryDiagnostic(latest.digest,latest.revision);
        state.metadata={...state.metadata,[TASK_ACCEPTANCE_KEY]:structuredClone(retained),[TASK_ACCEPTANCE_EVIDENCE_KEY]:serializeJsonValue({
          ...structuredClone(pending),...await taskAcceptanceOutcome(state,ledger),checks:serializeJsonValue(taskAcceptanceChecks()?.snapshot()??[]),...(violation?{status:'failed',diagnostic:serializeJsonValue(violation)}:{})
        })};
      }
      return target.save(...args);
    };
    const value:unknown=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
}
