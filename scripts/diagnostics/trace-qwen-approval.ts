/** Request-only diagnostic: never approves or executes the proposed mutation. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHarness, runHarness } from "../../src/runtime/harness.js";
import { createEditProposal } from "../../src/workspace/edit-contracts.js";
import { liveProviderSmokeInternals as smoke } from "../live-provider-smoke.js";
import { sanitizeOperationalError } from "../release-diagnostics.js";
const main = async () => {
  smoke.assertLiveOptIn(process.env);
  const realFetch = globalThis.fetch;
  const pending: Promise<void>[] = [];
  const wireCalls: {name:string; input:unknown}[] = [];
  let captureFailures = 0;
  globalThis.fetch = Object.assign(async (url:Parameters<typeof fetch>[0], init?:Parameters<typeof fetch>[1]) => {
    const response = await realFetch(url,init);
    pending.push(response.clone().text().then(raw=>{
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.stream) {
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
          const data = JSON.parse(line.slice(5));
          if (data.type === "response.output_item.done" && data.item?.type === "function_call") wireCalls.push({name:data.item.name,input:JSON.parse(data.item.arguments)});
        }
      } else {
        const data = JSON.parse(raw);
        for(const item of data.output ?? []) if(item.type === "function_call") wireCalls.push({name:item.name,input:JSON.parse(item.arguments)});
      }
    }).catch(()=>{captureFailures++;}));
    return response;
  },{preconnect:realFetch.preconnect});
  const workspace=await mkdtemp(path.join(os.tmpdir(),"zhx-qwen-approval-"));
  let harness:Awaited<ReturnType<typeof createHarness>>|undefined;
  let evidence:Record<string,unknown>={};
  try {
    harness=await createHarness({provider:"qwen",model:"qwen3.8-flash",workspace,stateDirectory:path.join(workspace,"state"),toolNames:["propose_edits","apply_patch"],maxSteps:4,subagentProfiles:[],env:process.env});
    const result=await runHarness(harness,{...smoke.providerRunInput("qwen",smoke.certificationPrompt("qwen")),scope:harness.config.scope});
    await Promise.all(pending);
    const approval=result.state.pendingApprovals.find(a=>a.name === "apply_patch");
    const actual=approval ? JSON.parse(approval.arguments) : undefined;
    const changes=[{path:"live-certification/qwen.txt",expectedDigest:null,content:"qwen live smoke\n"}];
    const expected={proposalId:createEditProposal({changes}).proposalId,changes};
    let mismatch:unknown;
    try {smoke.assertApprovalArguments(actual,expected);} catch(error){mismatch=sanitizeOperationalError(error);}
    evidence={waitingApproval:result.status === "waiting_approval",approvalPresent:Boolean(approval),exactArguments:!mismatch,captureFailures,wireCalls:wireCalls.map(c=>({tool:c.name === "apply_patch" || c.name === "propose_edits" ? c.name : "other",matchesExpected:isDeepStrictEqual(c.input,c.name === "propose_edits"?{changes}:expected),...(c.name === "apply_patch" ? {matchesApproval:isDeepStrictEqual(c.input,actual)}:{})})),...(mismatch ? {mismatch}:{}),...(result.error?{error:sanitizeOperationalError(result.error)}:{})};
  } catch(error){evidence={error:sanitizeOperationalError(error)};}
  finally {await harness?.close();await Promise.all(pending);globalThis.fetch=realFetch;await rm(workspace,{recursive:true,force:true});}
  process.stdout.write(JSON.stringify(evidence,null,2)+"\n");
};
if(import.meta.main) main().catch(error=>{process.stderr.write(JSON.stringify({error:sanitizeOperationalError(error)})+"\n");process.exitCode=1;});
