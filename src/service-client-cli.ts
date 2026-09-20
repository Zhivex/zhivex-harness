import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CliOptions } from "./cli.js";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "./local-service.js";
import type { HarnessClientCommand, HarnessClientData, HarnessClientRun, HarnessClientSession } from "./client-contract.js";
import { cliRunResultDocumentSchema } from "./json-contracts.js";
import { serializeStreamResult } from "./cli-stream.js";
import { HarnessConfigError, HarnessStateConflictError } from "./errors.js";
import { sanitizeTerminalText } from "./terminal-ui.js";
import { ConsoleInput } from "./console-input.js";

export const runServiceCli = async (options: CliOptions, annotate: (error: unknown, sequence: number) => Error): Promise<void> => {
  const credentials=await readHarnessLocalCredentials(options.serviceFile!);
  const hello=await requestHarnessLocalService(credentials,"hello",{versions:[1]});
  if(!hello.ok)throw new HarnessStateConflictError("Service negotiation failed.");
  const projectId=hello.projectId;let sequence=0;
  const key=(purpose:string, supplied?:string)=>createHash("sha256").update(`${purpose}:${supplied??randomUUID()}`).digest("hex");
  const call=async(command:Omit<HarnessClientCommand,"projectId">&Record<string,unknown>):Promise<HarnessClientData>=>{
    const r=await requestHarnessLocalService(credentials,"command",{protocolVersion:1,requestId:`request_${randomUUID()}`,connectionId:hello.connectionId,command:{projectId,...command}});
    if(!r.ok)throw new HarnessStateConflictError(`Service command failed: ${r.error.code}. Inspect durable state before retrying.`);
    return r.data;
  };
  const getSession=async(sessionId:string)=>{const r=await call({method:"session.get",sessionId});if(r.kind!=="session")throw new HarnessStateConflictError("Unexpected service response.");return r.session;};
  const list=async(search?:string)=>{const r=await call({method:"session.list",...(search?{search}:{})});if(r.kind!=="sessions")throw new HarnessStateConflictError("Unexpected service response.");return r.sessions;};
  const create=async(idempotencyKey?:string)=>{const r=await call({method:"session.create",idempotencyKey:key("session",idempotencyKey)});if(r.kind!=="session")throw new HarnessStateConflictError("Unexpected service response.");return r.session;};
  const print=(document:unknown)=>process.stdout.write((options.json?JSON.stringify(document,null,2):sanitizeTerminalText(JSON.stringify(document,null,2)))+"\n");
  if(options.command==="sessions"){
    if(options.sessionsCommand==="list"){
      const sessions=await list(options.sessionSearch);print({schemaVersion:1,kind:"session-list",sessions});return;
    }
    let session=await getSession(options.sessionId!);
    if(options.sessionsCommand==="rename"){
      const renamed=await call({method:"session.rename",sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:key("rename"),title:options.sessionTitle!});if(renamed.kind!=="session")throw new HarnessStateConflictError("Unexpected response.");session=renamed.session;
    }else if(options.sessionsCommand!=="inspect")throw new HarnessConfigError("Unsupported service session command.");
    print({schemaVersion:1,kind:"session",session});return;
  }
  if(!["run","resume","chat"].includes(options.command))throw new HarnessConfigError("This command does not support service mode.");
  let session:HarnessClientSession;
  if(options.sessionId)session=await getSession(options.sessionId);
  else if(options.command==="resume"){
    const found=(await list()).find(s=>s.runs.some(r=>r.runId===options.runId));if(!found)throw new HarnessStateConflictError("Run session not found; supply --session.");session=found;
  }else if(options.continueSession){const latest=(await list())[0];if(!latest)throw new HarnessStateConflictError("No session to continue.");session=latest;}
  else session=await create(options.idempotencyKey);
  let activeRun:string|undefined;
  const currentRun=async(runId=activeRun??session.runs.at(-1)?.runId)=>{
    if(!runId)return undefined;const r=await call({method:"run.get",sessionId:session.sessionId,runId});if(r.kind!=="run")throw new HarnessStateConflictError("Unexpected run response.");return r.run;
  };
  const cancel=async()=>{const run=await currentRun();if(run)await call({method:"run.cancel",sessionId:session.sessionId,runId:run.runId,expectedRevision:run.revision,idempotencyKey:key("cancel")});};
  const cursorAtEnd=async()=>{let after=0;for(;;){const page=await requestHarnessLocalService(credentials,"events",{projectId,sessionId:session.sessionId,after});after=page.nextCursor;if(page.cursorExpired||page.events.length<200)return after;}};
  const invoke=async(command:Omit<HarnessClientCommand,"projectId">&Record<string,unknown>)=>{
    let cursor=await cursorAtEnd();let finished=false,streamed=false;
    const pending=call(command).finally(()=>{finished=true;});
    // Attach a rejection handler immediately while activity is polled.
    void pending.catch(()=>undefined);
    try{
      do{
        const page=await requestHarnessLocalService(credentials,"events",{projectId,sessionId:session.sessionId,after:cursor});
        if(page.cursorExpired)throw new HarnessStateConflictError("Service activity cursor expired; reopen the session snapshot.");
        cursor=page.nextCursor;
        for(const event of page.events){activeRun=event.runId;const a=event.activity;if(a.type==="checkpoint"||a.type==="user-message")continue;
          if(options.jsonl)process.stdout.write(JSON.stringify({...a,schemaVersion:1,kind:"run-event",sequence:++sequence})+"\n");
          else if(!options.json&&typeof a.textDelta==="string"){process.stdout.write(sanitizeTerminalText(a.textDelta));streamed=true;}
        }
        if(!finished)await Promise.race([pending.then(()=>undefined,()=>undefined),delay(40)]);
      }while(!finished);
      // Drain events appended while the command response was in flight.
      for (;;) {
      const tail=await requestHarnessLocalService(credentials,"events",{projectId,sessionId:session.sessionId,after:cursor});
      if(tail.cursorExpired)throw new HarnessStateConflictError("Service activity cursor expired; inspect session.");
      for(const event of tail.events){const a=event.activity;if(a.type==="checkpoint"||a.type==="user-message")continue;if(options.jsonl)process.stdout.write(JSON.stringify({...a,schemaVersion:1,kind:"run-event",sequence:++sequence})+"\n");else if(!options.json&&typeof a.textDelta==="string"){process.stdout.write(sanitizeTerminalText(a.textDelta));streamed=true;}}
      cursor=tail.nextCursor;
      if(tail.events.length<200)break;
      }
      const result=await pending;if(result.kind!=="run")throw new HarnessStateConflictError("Unexpected run response.");session=result.session;
      return{run:result.run,streamed};
    }catch(e){throw annotate(e,sequence);}finally{activeRun=undefined;}
  };
  const finish=(run:HarnessClientRun,streamed:boolean)=>{
    const document=cliRunResultDocumentSchema.parse(run.cliResult);
    if(options.jsonl)process.stdout.write(serializeStreamResult({ runId: document.runId, status: document.status, provider: document.provider, model: document.model, steps: document.steps, toolCalls: document.toolCalls, pendingApprovals: document.pendingApprovals.map(a=>({id:a.id,kind:a.kind,name:a.name,...(a.childRunId?{childRunId:a.childRunId}:{}),...(a.childAgentId?{childAgentId:a.childAgentId}:{})})), children:document.children.map(c=>({runId:c.runId,status:c.status})) },++sequence)+"\n");
    else if(options.json)print({...document,sessionId:session.sessionId});
    else{if(!streamed)process.stdout.write(sanitizeTerminalText(document.output));process.stdout.write(`\nRun ${run.runId} · ${run.status} · session ${session.sessionId}\n`);}
    if(["failed","cancelled","timed_out"].includes(run.status))process.exitCode=1;
  };
  const decision=async(run:HarnessClientRun,approve:boolean)=>invoke({method:"approval.resolve",sessionId:session.sessionId,runId:run.runId,expectedRevision:run.revision,idempotencyKey:key("decision"),decisions:run.approvals.map(a=>({approvalId:a.approvalId,digest:a.digest,approve}))});
  const start=async(prompt:string)=>{
    session=await getSession(session.sessionId);
    let result=await invoke({method:"run.start",sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:key("run",options.idempotencyKey),prompt});
    while(options.yes&&result.run.status==="waiting_approval")result=await decision(result.run,true);
    finish(result.run,result.streamed);
  };
  const interrupt=()=>{void cancel().catch(()=>process.stderr.write("Cancellation conflicted; inspect the run before retrying.\n"));};
  process.on("SIGINT",interrupt);
  try{
    if(options.command==="resume"){
      const run=await currentRun(options.runId);if(!run)throw new HarnessStateConflictError("Run not found.");const result=await decision(run,options.approve===true);finish(result.run,result.streamed);return;
    }
    if(options.command==="run"){
      let prompt=options.prompt??"";
      if(!prompt&&!process.stdin.isTTY){for await(const chunk of process.stdin){prompt+=chunk.toString();if(Buffer.byteLength(prompt)>64*1024)throw new HarnessConfigError("Prompt exceeds 64 KiB.");}}
      if(!prompt.trim())throw new HarnessConfigError("A prompt is required.");await start(prompt);return;
    }
    const input=new ConsoleInput(process.stdin,process.stdout,Boolean(process.stdin.isTTY));input.onInterrupt=interrupt;
    try{
      process.stdout.write(`Session ${session.sessionId}. /help lists service commands.\n`);
      const previous=await currentRun();if(previous)print(previous);
      for(;;){const raw=await input.question("\n> ",true).catch(e=>{if(input.isClosed)return "/exit";throw e;});const literal=input.lastSubmissionWasPaste||raw.includes("\n");const text=literal?raw:raw.trim();if(!text)continue;
        if(!literal&&["/exit","/quit"].includes(text))break;
        try{
          if(!literal&&text.startsWith("/")){
            if(text==="/help")process.stdout.write("/sessions, /new, /resume <session>, /rename <title>, /status, /pending, /approve, /deny, /cancel, /exit. Provider and tool policy are configured by the service host.\n");
            else if(text==="/sessions")print(await list());
            else if(text==="/new"){session=await create();process.stdout.write(`Session ${session.sessionId}.\n`);}
            else if(text.startsWith("/resume ")){session=await getSession(text.slice(8).trim());print(await currentRun());}
            else if(text.startsWith("/rename ")){const r=await call({method:"session.rename",sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:key("rename"),title:text.slice(8)});if(r.kind==="session")session=r.session;}
            else if(["/status","/pending"].includes(text))print(await currentRun()??{message:"No run yet."});
            else if(text==="/cancel")await cancel();
            else if(["/approve","/deny"].includes(text)){const run=await currentRun();if(run){const r=await decision(run,text==="/approve");finish(r.run,r.streamed);}}
            else process.stdout.write("Unsupported service command. Use /help.\n");
          }else await start(text);
        }catch{process.stderr.write("Service operation failed. Inspect /status before retrying.\n");}
      }
    }finally{input.close();}
  }finally{process.off("SIGINT",interrupt);}
};
