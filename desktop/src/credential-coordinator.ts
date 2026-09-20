import type {CredentialStatus} from "./credential-store.js";
interface Host {isAlive():boolean;controlClose(action:"pause"|"resume"):Promise<boolean>;close():Promise<void>}
/** Serializes credential changes against runtime admission, without cancelling active runs. */
export function credentialCoordinator(deps:{busy():boolean;hosts():Promise<Host[]>;clear():void;configure():Promise<CredentialStatus>;delete():Promise<CredentialStatus>}){
 let changing=false;
 return {get changing(){return changing;},async change(action:"configure"|"delete"):Promise<CredentialStatus>{
  if(changing||deps.busy())throw new Error("CREDENTIAL_WORK_ACTIVE");changing=true;
  const paused:Host[]=[];let changed=false,closed=false;
  try{
   for(const host of await deps.hosts()){if(!host.isAlive())continue;paused.push(host);if(await host.controlClose("pause"))throw new Error("CREDENTIAL_WORK_ACTIVE");}
   const result=await deps[action]();
   // Lost helper output can hide a completed change. Dispose old credential holders too.
   changed=["saved","deleted","unavailable"].includes(result);
   if(changed){for(const host of paused)await host.close();deps.clear();closed=true;}
   return result;
  }finally{
   if(changed&&!closed){/* Fail closed: the application must restart before work resumes. */}
   else {try{for(const host of paused)if(host.isAlive())await host.controlClose("resume");}finally{changing=false;}}
  }
 }};
}
