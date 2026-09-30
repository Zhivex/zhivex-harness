import {expect,test} from 'bun:test';
import {selectContinuityProviders} from '../scripts/live-continuity-contract.js';
const providers=['openai','qwen','meta','gemini','anthropic','vertex'];
test('continuity preserves historical defaults and admits explicit announced routes',()=>{
 expect(selectContinuityProviders({},providers)).toEqual(['openai','qwen','meta']);
 expect(selectContinuityProviders({ZHIVEX_HARNESS_LIVE_PROVIDERS:'anthropic,gemini,vertex,vertex'},providers)).toEqual(['anthropic','gemini','vertex']);
});
test('continuity rejects empty or unavailable selection against artifact capabilities',()=>{
 for(const value of ['',',','unknown','vertex'])expect(()=>selectContinuityProviders({ZHIVEX_HARNESS_LIVE_PROVIDERS:value},['openai','qwen','meta'])).toThrow();
});
