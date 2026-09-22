import { navigateConsole } from "./console/console-navigation.js";
import { formatComposer } from "./console/console-presentation.js";
import { formatConsoleHelp } from "./console/console-commands.js";
import { formatConsoleWelcome } from "./console/console-welcome.js";
import { HARNESS_VERSION } from "../version.js";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CliOptions } from "./arguments.js";
import { readHarnessLocalCredentials, requestHarnessLocalService } from "../client/local-service.js";
import type { HarnessClientCommand, HarnessClientData, HarnessClientRun, HarnessClientSession } from "../client/protocol.js";
import { cliRunResultDocumentSchema } from "../client/json-contracts.js";
import { serializeStreamResult } from "./cli-stream.js";
import { HarnessConfigError, HarnessStateConflictError } from "../runtime/errors.js";
import { sanitizeTerminalText } from "./terminal/terminal-ui.js";
import { ConsoleInput } from "./console/console-input.js";

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
  const interrupt=()=>{if(!activeRun)return;void cancel().catch(()=>process.stderr.write("Cancellation conflicted; inspect the run before retrying.\n"));};
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
    const input=new ConsoleInput(process.stdin,process.stdout,Boolean(process.stdin.isTTY), "service");input.onInterrupt=interrupt;
    try{
      process.stdout.write(formatConsoleWelcome({version:HARNESS_VERSION, workspace:projectId, sessionId:session.sessionId, service:true}, {columns:process.stdout.columns??80}) + "\n");
      const previous=await currentRun();if(previous)print(previous);
      for(;;){
        process.stdout.write(formatComposer({ model: "local service", status: session.runs.at(-1)?.status === "waiting_approval" ? "approval pending · /pending" : "ready", ...(session.title ? {title:session.title}:{}), automaticApprovals:options.yes===true }, process.stdout.columns));
        const raw=await input.question("\n> ",true).catch(e=>{if(input.isClosed)return "/exit";if(e instanceof Error&&e.name==="AbortError")return "";throw e;});const literal=input.lastSubmissionWasPaste||raw.includes("\n");let text=literal?raw:raw.trim();if(!text)continue;
        if(!literal&&["/exit","/quit"].includes(text))break;
        try{
          if(!literal&&text.startsWith("/")){
            if(text==="/menu"){
              const selected=await navigateConsole(input,{entry:"menu",current:{provider:"service",model:"host"},providers:[],service:true,sessions:async()=>(await list()).map(s=>({value:s.sessionId,label:s.title??"Untitled conversation",detail:s.sessionId}))});
              if(!selected||!("command" in selected))continue;text=selected.command;
            }
            if(text==="/help"||text==="/help all")process.stdout.write(formatConsoleHelp("service",text==="/help all"));
            else if(text==="/sessions"||text.startsWith("/sessions "))print(await list(text.slice(9).trim()||undefined));
            else if(text==="/new"){session=await create();input.clearHistory();process.stdout.write(`Session ${session.sessionId}.\n`);}
            else if(text==="/resume"||text.startsWith("/resume ")){
              let id=text.slice(7).trim();
              if(!id){const selected=await input.select("Zhivex / Conversations",(await list()).map(s=>({value:s.sessionId,label:s.title??"Untitled conversation",detail:s.sessionId})));if(!selected)continue;id=selected;}
              session=await getSession(id);input.clearHistory();print(await currentRun());}
            else if(text.startsWith("/rename ")){const r=await call({method:"session.rename",sessionId:session.sessionId,expectedRevision:session.revision,idempotencyKey:key("rename"),title:text.slice(8)});if(r.kind==="session")session=r.session;}
            else if(["/status","/pending"].includes(text))print(await currentRun()??{message:"No run yet."});
            else if(text==="/paste"){
              const draft=await input.multiline();
              process.stdout.write(`Draft preview:\n${sanitizeTerminalText(draft)}\n`);
              if((await input.question("Send this draft? Type send: ")).trim()==="send" && draft.trim()){
                input.rememberPrompt(draft,true);await start(draft);
              }
            }
            else if(text==="/cancel")await cancel();
            else if(["/approve","/deny"].includes(text)){const run=await currentRun();if(run){const r=await decision(run,text==="/approve");finish(r.run,r.streamed);}}
            else process.stdout.write("Unsupported service command. Use /help.\n");
          }else {input.rememberPrompt(text,literal);await start(text);}
        }catch{if(input.isClosed)break;process.stderr.write("Service operation failed. Inspect /status before retrying.\n");}
      }
    }finally{input.close();}
  }finally{process.off("SIGINT",interrupt);}
};
