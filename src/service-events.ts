/** Durable, bounded, redacted client activity. Never persist raw tool payloads. */
import { createHash } from "node:crypto";
import { createRedactionPolicy, type AgentStreamEvent } from "@zhivex-ai/agents";
import { SqliteDatabase } from "./sqlite-database.js";
import { openCliSessionStore } from "./sessions.js";
import { streamEventDocument } from "./cli-stream.js";
import type { HarnessConfig } from "./config.js";

export interface HarnessActivityEvent { schemaVersion: 1; eventId: string; sequence: number; sessionId: string; runId: string; at: number; activity: Record<string, unknown> }
export interface HarnessActivityRun {text:string;status:string;truncated:boolean;prompt?:string;tools?:Record<string,{name:string;status:string;exitCode?:number;timedOut?:boolean}>}
export interface HarnessActivitySnapshot { schemaVersion: 1; sessionId: string; sequence: number; runs: Record<string, HarnessActivityRun> }
export interface HarnessActivityPage { schemaVersion: 1; cursorExpired: boolean; nextCursor: number; events: HarnessActivityEvent[]; snapshot?: HarnessActivitySnapshot }
export interface HarnessActivityStore {
  prompt(sessionId:string,runId:string,prompt:string):void;
  append(sessionId: string, runId: string, event: AgentStreamEvent): void;
  checkpoint(sessionId: string, runId: string, status: string): void;
  replay(sessionId: string, after?: number): HarnessActivityPage;
  close(): void;
}
export interface HarnessActivityOptions { maxEvents?: number; retentionMs?: number; sensitiveValues?: readonly string[]; now?: () => number }
export const openHarnessActivityStore = async (config: HarnessConfig, options: HarnessActivityOptions = {}): Promise<HarnessActivityStore> => {
  const index = await openCliSessionStore({workspace:config.workspace,stateDirectory:config.stateDirectory,scope:config.scope});
  const scope = `${index.workspaceKey}:${index.scopeKey}`;
  const db = new SqliteDatabase(index.databasePath); index.close();
  const maxEvents = options.maxEvents ?? 10_000, retentionMs = options.retentionMs ?? 7*24*3600*1000, now=options.now??Date.now;
  if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>100_000||!Number.isSafeInteger(retentionMs)||retentionMs<1) {db.close();throw new Error("ACTIVITY_LIMIT_INVALID");}
  db.exec(`CREATE TABLE IF NOT EXISTS client_activity_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL, at INTEGER NOT NULL, activity TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS client_activity_scope ON client_activity_events(scope, session, sequence);
    CREATE TABLE IF NOT EXISTS client_activity_snapshots(scope TEXT NOT NULL, session TEXT NOT NULL, sequence INTEGER NOT NULL, expired_through INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL, PRIMARY KEY(scope,session));`);
  const redaction = createRedactionPolicy({includeEmails:true});
  const redact=(text:string)=>{
    let result=text;
    for(const secret of options.sensitiveValues??[]) if(secret)result=result.split(secret).join("[REDACTED]");
    return redaction.redactText(result).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi,"[REDACTED]");
  };
  // Hold the unfinished word: secrets split over provider chunks are never emitted piecemeal.
  const redactValue=(value:unknown):unknown => typeof value === "string" ? redact(value) : Array.isArray(value) ? value.map(redactValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redactValue(v)])) : value;
  const tails=new Map<string,string>(); const discard=new Set<string>();
  const flush=(key:string,chunk:string,final=false)=>{
    let text=(tails.get(key)??"")+chunk;
    // Replace complete known values before selecting a whitespace boundary. Known
    // credentials can themselves contain spaces and span several provider chunks.
    for(const secret of options.sensitiveValues??[])if(secret)text=text.split(secret).join("[REDACTED]");
    if(discard.has(key)){const end=text.search(/\s/);if(end<0&&!final)return "";text=end<0?"":text.slice(end);discard.delete(key);}
    let boundary=final?text.length:(text.match(/^[\s\S]*\s/)?.[0].length??0);
    if(!final)for(const secret of options.sensitiveValues??[]){
      if(!secret)continue;
      let start=text.indexOf(secret[0]!,Math.max(0,text.length-secret.length+1));
      while(start>=0&&start<boundary){if(secret.startsWith(text.slice(start))){boundary=start;break;}start=text.indexOf(secret[0]!,start+1);}
    }
    let result=redact(text.slice(0,boundary));text=text.slice(boundary);
    if(text.length>16_384){result+="[TRUNCATED]";text="";discard.add(key);}
    tails.set(key,text);return result;
  };
  const snapshot=(sessionId:string)=>{
    const row=db.query<{snapshot:string;expired_through:number}>("SELECT snapshot,expired_through FROM client_activity_snapshots WHERE scope=? AND session=?").get(scope,sessionId);
    return { state:row?JSON.parse(row.snapshot) as HarnessActivitySnapshot:{schemaVersion:1 as const,sessionId,sequence:0,runs:{}}, expiredThrough:row?.expired_through??0 };
  };
  const prune=()=>{
    const expired=db.query<{session:string;seq:number}>(`SELECT session,MAX(sequence) AS seq FROM client_activity_events WHERE scope=? AND (at < ? OR sequence NOT IN (SELECT sequence FROM client_activity_events WHERE scope=? ORDER BY sequence DESC LIMIT ?)) GROUP BY session`).all(scope,now()-retentionMs,scope,maxEvents);
    for(const row of expired){db.query("UPDATE client_activity_snapshots SET expired_through=MAX(expired_through,?) WHERE scope=? AND session=?").run(row.seq,scope,row.session);db.query("DELETE FROM client_activity_events WHERE scope=? AND session=? AND sequence<=?").run(scope,row.session,row.seq);}
  };
  const write=(sessionId:string,runId:string,activity:Record<string,unknown>)=>{
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)||!/^[A-Za-z0-9._:-]{1,128}$/.test(runId))throw new Error("ACTIVITY_ID_INVALID");
    const at=now();const encoded=JSON.stringify(activity);if(Buffer.byteLength(encoded)>64*1024)throw new Error("ACTIVITY_TOO_LARGE");
    db.exec("BEGIN IMMEDIATE");try{
      const current=snapshot(sessionId).state;
      const runs=Object.keys(current.runs);if(!current.runs[runId]&&runs.length>=1000)throw new Error("ACTIVITY_RUN_LIMIT");
      const state:HarnessActivityRun=current.runs[runId]??{text:"",status:"running",truncated:false};
      if(typeof activity.textDelta==="string") {state.text+=activity.textDelta;if(state.text.length>256*1024){state.text=state.text.slice(-256*1024);state.truncated=true;}}
      if(activity.type==="user-message"&&typeof activity.prompt==="string")state.prompt=activity.prompt;
      if(typeof activity.toolCallId==="string"&&typeof activity.toolName==="string"){
        state.tools??={};const key=`tool:${activity.toolCallId}`;
        if(state.tools[key]||Object.keys(state.tools).length<256){
          const status=activity.type==="tool-result"?(activity.isError===true||activity.timedOut===true||typeof activity.exitCode==="number"&&activity.exitCode!==0?"failed":"completed"):"running";
          state.tools[key]={name:activity.toolName,status,...(typeof activity.exitCode==="number"?{exitCode:activity.exitCode}:{}),...(typeof activity.timedOut==="boolean"?{timedOut:activity.timedOut}:{})};
        }else state.truncated=true;
      }
      if(typeof activity.status==="string"&&(activity.type==="checkpoint"||activity.type==="agent-run-finish"))state.status=activity.status;
      if(activity.type==="agent-run-start")state.status="running";
      if(activity.type==="tool-approval-request"||activity.type==="agent-approval-request")state.status="waiting_approval";
      current.runs[runId]=state;
      if(Buffer.byteLength(JSON.stringify(current))>2*1024*1024)throw new Error("ACTIVITY_SNAPSHOT_LIMIT");
      db.query("INSERT INTO client_activity_events(scope,session,run,at,activity) VALUES(?,?,?,?,?)").run(scope,sessionId,runId,at,encoded);
      current.sequence=db.query<{seq:number}>("SELECT last_insert_rowid() AS seq").get()!.seq;
      db.query("INSERT INTO client_activity_snapshots(scope,session,sequence,snapshot) VALUES(?,?,?,?) ON CONFLICT(scope,session) DO UPDATE SET sequence=excluded.sequence,snapshot=excluded.snapshot").run(scope,sessionId,current.sequence,JSON.stringify(current));
      prune();db.exec("COMMIT");
    }catch(e){db.exec("ROLLBACK");throw e;}
  };
  return {
    prompt(sessionId,runId,prompt){const safe=redact(prompt);const truncated=Buffer.byteLength(safe)>60*1024;write(sessionId,runId,{type:"user-message",prompt:truncated?Buffer.from(safe).subarray(0,60*1024).toString("utf8")+"[TRUNCATED]":safe});},
    append(sessionId,runId,event){
      const key=`${sessionId}:${runId}`;
      if(event.type==="text-delta"){
        const textDelta=flush(key,event.textDelta);if(textDelta)write(sessionId,runId,{type:"text-delta",textDelta});return;
      }
      if(event.type==="agent-run-finish"||event.type==="error"){
        const textDelta=flush(key,"",true);if(textDelta)write(sessionId,runId,{type:"text-delta",textDelta});tails.delete(key);
      }
      const projected=streamEventDocument(event);
      if(projected){
        let receipt:Record<string,unknown>={};
        if(event.type==="tool-result"&&event.toolResult.toolName==="run_check"){
          const output=event.toolResult.output;
          if(output&&typeof output==="object"&&!Array.isArray(output)&&"exitCode" in output&&Number.isSafeInteger(output.exitCode))receipt={exitCode:output.exitCode,timedOut:"timedOut" in output&&output.timedOut===true};
        }
        write(sessionId,runId,redactValue({...projected,...receipt}) as Record<string,unknown>);
      }
    },
    checkpoint(sessionId,runId,status){const key=`${sessionId}:${runId}`;const textDelta=flush(key,"",true);if(textDelta)write(sessionId,runId,{type:"text-delta",textDelta});tails.delete(key);write(sessionId,runId,{type:"checkpoint",status});},
    replay(sessionId,after=0){
      if(!Number.isSafeInteger(after)||after<0)throw new Error("ACTIVITY_CURSOR_INVALID");
      db.exec("BEGIN IMMEDIATE");try{prune();db.exec("COMMIT");}catch(e){db.exec("ROLLBACK");throw e;}
      const current=snapshot(sessionId);const expired=after<current.expiredThrough;
      if(after>current.state.sequence)throw new Error("ACTIVITY_CURSOR_AHEAD");
      if(expired)return {schemaVersion:1,cursorExpired:true,nextCursor:current.state.sequence,events:[],snapshot:current.state};
      const rows=db.query<{sequence:number;session:string;run:string;at:number;activity:string}>("SELECT sequence,session,run,at,activity FROM client_activity_events WHERE scope=? AND session=? AND sequence>? ORDER BY sequence LIMIT 200").all(scope,sessionId,after);
      const events=rows.map(row=>({schemaVersion:1 as const,eventId:createHash("sha256").update(`${scope}:${row.sequence}`).digest("hex"),sequence:row.sequence,sessionId:row.session,runId:row.run,at:row.at,activity:JSON.parse(row.activity)}));
      return {schemaVersion:1,cursorExpired:false,nextCursor:events.at(-1)?.sequence??after,events};
    },
    close(){db.close();tails.clear();discard.clear();}
  };
};
