import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CliSessionStore } from './sessions.js';
import { harnessPolicyDecisionEventSchema } from '../runtime/policy-decisions.js';
import { changeEnvelopeSchema, verifyChangeEnvelope } from '../workspace/change-envelope.js';

const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count=z.number().int().nonnegative().safe();
export const governanceReference=(kind:string,value:string)=>'sha256:'+createHash('sha256').update(JSON.stringify([kind,value])).digest('hex');
export const governanceSessionSchema=z.strictObject({availability:z.enum(['recorded','unavailable']),reference:digest.nullable(),revision:count.nullable()});
export const governanceHistorySchema=z.strictObject({availability:z.enum(['recorded','unavailable']),retention:z.enum(['unknown','retained','expired']),
  incomplete:z.boolean(),policyDecisions:z.array(z.strictObject({runReference:digest,sequence:count,toolReference:digest,
    phase:z.enum(['approval-request','tool-entry']),decision:z.enum(['allow','ask_user','deny']),policyDigest:digest.nullable(),
    source:z.enum(['operator-file','application','baseline']),ruleReferences:z.array(digest).max(128),explicitReviewRequired:z.boolean()})).max(512)});
export const governanceEnvelopeSchema=z.strictObject({source:z.literal('caller-supplied'),envelopeId:digest.nullable(),
  patchReference:digest.nullable(),patchDigest:digest.nullable(),linkedRunReferences:z.array(digest).max(64),
  schemaValid:z.boolean(),integrity:z.enum(['valid','invalid']),expiration:z.enum(['unknown','current','expired','not-yet-valid']),
  checkedAt:z.iso.datetime(),expiredApprovals:count,authenticity:z.literal('not-verified'),patchBytes:z.literal('not-verified')});

/** Both readers must already be bound to the same workspace and scope as the run store. */
export interface GovernanceSessionSource {
  id:string;
  index:Pick<CliSessionStore,'get'>;
  history?:{replay(sessionId:string,after?:number):{
    schemaVersion:1;cursorExpired:boolean;hasMore?:boolean;policyEvidenceIncomplete?:boolean;nextCursor:number;
    events:Array<{sessionId:string;runId:string;sequence:number;activity:Record<string,unknown>}>;
  }};
}

export async function readGovernanceSession(source:GovernanceSessionSource|undefined,rootRunId:string,runIds:ReadonlySet<string>) {
  const session:z.infer<typeof governanceSessionSchema>={availability:'unavailable',reference:null,revision:null};
  const history:z.infer<typeof governanceHistorySchema>={availability:'unavailable',retention:'unknown',incomplete:true,policyDecisions:[]};
  if(!source)return {session,history,verify:async()=>{}};
  const initial=await source.index.get(source.id);
  if(!initial || initial.sessionId!==source.id || !initial.runs.some(run=>run.runId===rootRunId))throw new Error('GOVERNANCE_SESSION_MISMATCH');
  const captured=JSON.stringify(initial);
  session.availability='recorded';session.reference=governanceReference('session',initial.sessionId);session.revision=initial.revision;
  const pages:Array<{cursor:number;digest:string}>=[];
  if(source.history) {
    let cursor=0;
    history.availability='recorded';history.retention='retained';history.incomplete=false;
    for(let pageIndex=0;pageIndex<50;pageIndex++) {
      const page=source.history.replay(source.id,cursor);
      pages.push({cursor,digest:governanceReference('history-page',JSON.stringify(page))});
      if(page.schemaVersion!==1 || !Number.isSafeInteger(page.nextCursor) || page.nextCursor<cursor || page.events.length>200)throw new Error('GOVERNANCE_HISTORY_INVALID');
      if(page.cursorExpired || page.policyEvidenceIncomplete){history.retention='expired';history.incomplete=true;}
      let lastSequence=cursor;
      for(const event of page.events) {
        if(event.sessionId!==source.id || !Number.isSafeInteger(event.sequence) || event.sequence<=lastSequence || event.sequence>page.nextCursor)throw new Error('GOVERNANCE_HISTORY_INVALID');
        lastSequence=event.sequence;
        if(!runIds.has(event.runId) || event.activity.type!=='policy-decision')continue;
        const parsed=harnessPolicyDecisionEventSchema.safeParse(event.activity);
        if(!parsed.success){history.incomplete=true;continue;}
        if(history.policyDecisions.length===512){history.incomplete=true;continue;}
        const value=parsed.data;
        history.policyDecisions.push({runReference:governanceReference('run',event.runId),sequence:event.sequence,toolReference:governanceReference('tool',value.toolName),
          phase:value.phase,decision:value.decision,policyDigest:value.policyDigest,source:value.source,ruleReferences:value.ruleIds.map(rule=>governanceReference('rule',rule)),explicitReviewRequired:value.explicitReviewRequired});
      }
      if(page.cursorExpired || !page.hasMore)break;
      if(page.nextCursor===cursor)throw new Error('GOVERNANCE_HISTORY_INVALID');
      cursor=page.nextCursor;
      if(pageIndex===49)history.incomplete=true;
    }
  }
  return {session,history,verify:async()=>{
    for(const page of pages)if(governanceReference('history-page',JSON.stringify(source.history!.replay(source.id,page.cursor)))!==page.digest)throw new Error('GOVERNANCE_STATE_CHANGED');
    if(JSON.stringify(await source.index.get(source.id))!==captured)throw new Error('GOVERNANCE_STATE_CHANGED');
  }};
}

/** Envelopes are references supplied by the caller, never inferred signatures or executed checks. */
export function projectGovernanceEnvelopes(envelopes:readonly unknown[],patches:ReadonlyMap<string,readonly string[]>,now:number) {
  if(envelopes.length>32)throw new Error('GOVERNANCE_ENVELOPE_LIMIT');
  return envelopes.map(input=>{
    if(Buffer.byteLength(JSON.stringify(input)??'')>256*1024)throw new Error('GOVERNANCE_ENVELOPE_LIMIT');
    const parsed=changeEnvelopeSchema.safeParse(input);
    const proof=verifyChangeEnvelope(input,{now});
    const envelope=parsed.success?parsed.data:undefined;
    return governanceEnvelopeSchema.parse({source:'caller-supplied',envelopeId:envelope?.envelopeId??null,
      patchReference:envelope?governanceReference('patch',envelope.patch.patchId):null,patchDigest:envelope?.patch.patchDigest??null,
      linkedRunReferences:envelope?[...(patches.get(envelope.patch.patchId)??[])]:[],schemaValid:parsed.success,
      integrity:proof.integrity.envelopeDigestValid && proof.integrity.evidenceDigestValid?'valid':'invalid',
      expiration:!envelope?'unknown':proof.expiration.envelopeNotYetValid?'not-yet-valid':proof.expiration.envelopeExpired?'expired':'current',
      checkedAt:proof.expiration.checkedAt,expiredApprovals:proof.expiration.expiredApprovalIds.length,authenticity:'not-verified',patchBytes:'not-verified'});
  });
}
