import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness } from "../packages/core/src/runtime/harness.js";
import { startHarnessLocalService } from "../packages/core/src/client/local-service.js";
import { parseCliArgs } from "../packages/core/src/cli.js";
import { parseCliJsonLineDocument, parseCliJsonDocument } from "../packages/core/src/client/json-contracts.js";

test("service CLI options preserve host authority and literal prompts",()=>{
 expect(parseCliArgs(["run","--service","/private/host.json","--","--provider"])).toMatchObject({serviceFile:"/private/host.json",prompt:"--provider"});
 expect(()=>parseCliArgs(["run","--service","/private/host.json","--provider","openai","hi"])).toThrow();
 expect(()=>parseCliArgs(["run","--session","ses_example","hi"])).toThrow();
 expect(parseCliArgs(["resume","run_example","--service","/private/host.json","--session","ses_example","--approve"])).toMatchObject({approve:true});
});

test("CLI drains multiple replay pages and preserves versioned results and sessions",async()=>{
 const root=await mkdtemp("/tmp/har-cli-service-");
 const model=createMockLanguageModel({streamEvents:[[...Array.from({length:450},(_,i)=>({type:"text-delta" as const,textDelta:`word${i} `})),{type:"finish",finishReason:"stop"}]]});
 const harness=await createHarness({workspace:root,provider:"openai",modelInstance:model,subagentProfiles:[]});
 const service=await startHarnessLocalService(harness,{directory:root+"/socket"});
 const cli=async(args:string[])=>{
  const p=Bun.spawn([process.execPath,"--no-env-file","packages/core/src/cli.ts",...args,"--service",service.credentialsPath],{stdin:"ignore",stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH,HOME:root}});
  const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  expect(stderr).toBe("");expect(code).toBe(0);return stdout;
 };
 try{
  const lines=(await cli(["run","--jsonl","hello"])).trim().split("\n").map(l=>parseCliJsonLineDocument(JSON.parse(l)));
  expect(lines.at(-1)).toMatchObject({kind:"run-stream-result",status:"completed"});
  expect(lines.map(l=>l.sequence)).toEqual(lines.map((_,i)=>i+1));
  expect(lines.filter(l=>l.kind==="run-event").map(l=>"textDelta" in l?l.textDelta:"").join("")).toBe(Array.from({length:450},(_,i)=>`word${i} `).join(""));
  const listed=JSON.parse(await cli(["sessions","list","--json"]));parseCliJsonDocument(listed);
  expect(listed.sessions).toHaveLength(1);
  const inspected=JSON.parse(await cli(["sessions","inspect",listed.sessions[0].sessionId,"--json"]));parseCliJsonDocument(inspected);
  expect(inspected.session.runs[0].status).toBe("completed");
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
},20000);

test('JSON CLI returns the durable result when activity expires during execution', async () => {
 const root = await mkdtemp('/tmp/har-cli-expired-');
 let executions = 0;
 const base = createMockLanguageModel({streamEvents: [[...Array.from({length: 30}, () => ({type: 'text-delta' as const, textDelta: 'word '})), {type: 'finish', finishReason: 'stop'}]]});
 const harness = await createHarness({workspace: root, provider: 'openai', subagentProfiles: [], modelInstance: {...base, stream(input) {executions++; return base.stream!(input);}}});
 const service = await startHarnessLocalService(harness, {directory: root + '/socket', maxEvents: 3});
 try {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'packages/core/src/cli.ts', 'run', '--json', 'hello', '--service', service.credentialsPath], {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: {PATH: process.env.PATH, HOME: root}});
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(''); expect(code).toBe(0);
  const result = parseCliJsonDocument(JSON.parse(stdout));
  expect(result).toMatchObject({status: 'completed', output: 'word '.repeat(30)});
  expect(executions).toBe(1);
  const {connectApplication} = await import('../packages/core/src/application/client.js');
  const client = await connectApplication(service.credentialsPath);
  const sessions = await client.command({method: 'session.list'});
  if (!sessions.ok || sessions.data.kind !== 'sessions') throw new Error('SESSIONS_FAILED');
  expect((await client.events(sessions.data.sessions[0]!.sessionId)).cursorExpired).toBe(true);
 } finally {await service.close(); await rm(root, {recursive: true, force: true});}
}, 20000);
