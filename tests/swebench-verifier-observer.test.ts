import { test, expect } from 'bun:test';
import { observeVerifierFailures } from '../scripts/swebench/verifier-observer.js';
import type { ToolSet } from '@zhivex-ai/core';

test('private verifier observer preserves approval, error identity and bounded capture',async()=>{
 const error=Object.assign(new Error('PRIVATE error must not be copied'),{verification:{exitCode:1,timedOut:false,diagnostics:{stdout:'x'.repeat(3000),stderr:'fixture'}}});
 let executions=0;const records:unknown[]=[];
 const tool={requiresApproval:true,approvalMode:'interrupt',approvalVersion:'unchanged',execute:async()=>{executions++;throw error;}};
 const original={verify_and_apply_environment_patch:tool} as unknown as ToolSet;
 expect(observeVerifierFailures(original)).toBe(original);
 const wrapped=observeVerifierFailures(original,r=>{records.push(r);throw new Error('observer failed');});
 expect(wrapped.verify_and_apply_environment_patch).toMatchObject({requiresApproval:true,approvalMode:'interrupt',approvalVersion:'unchanged'});
 const execute=(wrapped.verify_and_apply_environment_patch as unknown as typeof tool).execute as (...args:unknown[])=>Promise<unknown>;
 for(let n=0;n<4;n++)await expect(execute({command:'python',args:['-c','assert False']})).rejects.toBe(error);
 expect(executions).toBe(4);expect(records).toHaveLength(3);
 expect(records[0]).toMatchObject({command:'python',args:['-c','assert False'],exitCode:1,stdout:'x'.repeat(2048),stderr:'fixture'});
 expect(JSON.stringify(records)).not.toContain('PRIVATE');
});
