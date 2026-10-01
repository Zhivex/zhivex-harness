import {expect,test} from 'bun:test';
import {continuityGateOutcome, selectContinuityProviders} from '../scripts/live-continuity-contract.js';
import { HarnessProviderError } from '../src/runtime/errors.js';
import { diagnosticFingerprint, sanitizeOperationalError } from '../scripts/release-diagnostics.js';
const providers=['openai','qwen','meta','gemini','anthropic','vertex'];
test('continuity preserves historical defaults and admits explicit announced routes',()=>{
 expect(selectContinuityProviders({},providers)).toEqual(['openai','qwen','meta']);
 expect(selectContinuityProviders({ZHIVEX_HARNESS_LIVE_PROVIDERS:'anthropic,gemini,vertex,vertex'},providers)).toEqual(['anthropic','gemini','vertex']);
});

test('continuity projects failed checks and provider causes without retaining raw phase fields', () => {
 const secret = 'PRIVATE_MODEL_OUTPUT_DO_NOT_LOG';
 const diagnostic = sanitizeOperationalError(Object.assign(new HarnessProviderError(secret, {retryable:true}), {status:503}));
 const outcome = continuityGateOutcome({provider:'qwen', status:'failed', phases:[
  {phase:0,status:'passed'}, {phase:1,status:'failed',diagnostic,checks:{codename:false,objective:false,[secret]:false},message:secret}
 ]});
 expect(outcome).toMatchObject({provider:'qwen',ok:false,error:{code:'PROVIDER_UNAVAILABLE',retryable:true,status:503}});
 expect(outcome.error!.details!.chain[0]).toEqual({checkpoint:'continuity_phase',continuity:{phase:1,failedChecks:['codename','objective']}});
 expect(JSON.stringify(outcome)).not.toContain(secret);
 expect(outcome.error!.details!.chain[1]).toEqual(diagnostic.details!.chain[0]);
 const {fingerprint,...projection}=outcome.error!;
 expect(fingerprint).toBe(diagnosticFingerprint(projection));
 expect(continuityGateOutcome({provider:'qwen',status:'missing_credentials'})).toMatchObject({ok:false,error:{code:'CONFIG_INVALID'}});
 expect(continuityGateOutcome({provider:'qwen',status:'passed'})).toEqual({provider:'qwen',ok:true});
 expect(continuityGateOutcome({provider:'qwen',status:'failed',phases:[{phase:99,status:'failed',diagnostic:{message:secret}}]}))
  .toMatchObject({ok:false,error:{code:'EXECUTION_FAILED'}});
});
test('continuity rejects empty or unavailable selection against artifact capabilities',()=>{
 for(const value of ['',',','unknown','vertex'])expect(()=>selectContinuityProviders({ZHIVEX_HARNESS_LIVE_PROVIDERS:value},['openai','qwen','meta'])).toThrow();
});
