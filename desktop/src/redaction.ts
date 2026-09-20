import { createRedactionPolicy } from "@zhivex-ai/agents";
import type { HarnessClientResponse } from "../../src/client-contract.js";
export const hostSensitiveValues=(env:NodeJS.ProcessEnv)=>Object.entries(env).filter(([key,value])=>/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)&&Boolean(value)).map(([,value])=>value!);
export function desktopRedactor(secrets:readonly string[]){
 const policy=createRedactionPolicy({includeEmails:true});
 const text=(value:string)=>{let output=value;for(const secret of secrets)if(secret)output=output.split(secret).join("[REDACTED]");return policy.redactText(output).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi,"[REDACTED]");};
 const redact=(value:unknown):unknown=>typeof value==="string"?text(value):Array.isArray(value)?value.map(redact):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redact(item)])):value;
 return {text,redact,response(response:HarnessClientResponse):HarnessClientResponse{
  const safe=structuredClone(response);
  if(safe.ok&&safe.data.kind==="run"){
   // Rich CLI documents and engine output never enter the renderer. It reads redacted activity.
   safe.data.run.output="";delete safe.data.run.cliResult;
   for(const decision of safe.data.run.decisions??[]){const diff=decision.finalDiff;if(diff?.status==="complete"&&JSON.stringify(redact(diff.files))!==JSON.stringify(diff.files))diff.redacted=true;}
   for(const approval of safe.data.run.approvals){const action=approval.action as {name?:unknown};approval.action={name:typeof action?.name==="string"?text(action.name):"tool"};}
  }
  return redact(safe) as HarnessClientResponse;
 }};
}
