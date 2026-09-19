import {expect,test} from "bun:test";
import {tool} from "@zhivex-ai/agents";
import {createMockLanguageModel} from "@zhivex-ai/agents/testing";
import {z} from "zod";
import type {StreamEvent,ModelGenerateInput} from "@zhivex-ai/core";
import {createRepairController,REPAIR_CONTROLLER_KEY} from "../src/repair-controller.js";
import {createModelBudget} from "../src/model-budget.js";
const model=createMockLanguageModel();
const input=():ModelGenerateInput=>({messages:[],tools:{read_task:tool({name:"read_task",schema:z.object({}),execute:async()=>"original task"})}});
const pending=()=>{const c=createRepairController({},true);c.state.verifier={command:"node",args:["verify.mjs"],purpose:"assert required fix"};return c;};
const stop=async function*():AsyncIterable<StreamEvent>{yield {type:"finish",finishReason:"stop",usage:{inputTokens:12,outputTokens:8}};};
test("one durable reminder preserves actual usage and cannot repeat after resume",async()=>{
 const c=pending(),b=createModelBudget({inputTokens:1000,outputTokens:1000});
 const ctx={input:input(),model};
 const stream=await c.middleware.wrapStream!(ctx,()=>b.middleware.wrapStream!(ctx,async()=>stop()));
 const events=[];for await(const e of stream)events.push(e);
 expect(events.some(e=>e.type==="tool-call"&&e.toolCall.name==="read_task")).toBe(true);
 expect(events.at(-1)).toMatchObject({type:"finish",finishReason:"tool-calls",usage:{inputTokens:12,outputTokens:8}});
 expect(b.stats).toMatchObject({inputTokens:12,outputTokens:8,modelCalls:1,usageComplete:true});
 const restored=createRepairController({[REPAIR_CONTROLLER_KEY]:c.snapshot()},true);
 const next=await restored.middleware.wrapStream!({input:input(),model},async()=>stop());
 const repeated=[];for await(const e of next)repeated.push(e);
 expect(repeated.some(e=>e.type==="tool-call")).toBe(false);
 expect(restored.completionPending()).toBe(true);
});
for(const reason of ["length","error"] as const)test(`never extends a ${reason} termination`,async()=>{
 const c=pending();const stream=await c.middleware.wrapStream!({input:input(),model},async()=>(async function*():AsyncIterable<StreamEvent>{yield {type:"finish",finishReason:reason,usage:{inputTokens:12,outputTokens:8}};})());
 const events=[];for await(const e of stream)events.push(e);expect(events.some(e=>e.type==="tool-call")).toBe(false);
});
test("unknown usage does not trigger a reminder",async()=>{
 const c=pending();const stream=await c.middleware.wrapStream!({input:input(),model},async()=>(async function*():AsyncIterable<StreamEvent>{yield {type:"finish",finishReason:"stop"};})());
 const events=[];for await(const e of stream)events.push(e);expect(events.some(e=>e.type==="tool-call")).toBe(false);
});
test("generate preserves text and real usage when appending a reminder",async()=>{
 const c=pending();const r=await c.middleware.wrapGenerate!({input:input(),model},async()=>({message:{role:"assistant",parts:[{type:"text",text:"premature final"}]},finishReason:"stop",usage:{inputTokens:12,outputTokens:8}}));
 expect(r.finishReason).toBe("tool-calls");expect(r.usage).toEqual({inputTokens:12,outputTokens:8});
 expect(r.message?.parts[0]).toEqual({type:"text",text:"premature final"});
 expect(r.message?.parts.at(-1)).toMatchObject({type:"tool-call",toolCall:{name:"read_task"}});
});

test("a late stream failure never schedules a reminder",async()=>{
 const c=pending(),error=new Error("fixture late failure");
 const stream=await c.middleware.wrapStream!({input:input(),model},async()=>(async function*():AsyncIterable<StreamEvent>{yield {type:"finish",finishReason:"stop",usage:{inputTokens:12,outputTokens:8}};throw error;})());
 const events:StreamEvent[]=[];
 await expect((async()=>{for await(const e of stream)events.push(e);})()).rejects.toBe(error);
 expect(events.some(e=>e.type==="tool-call")).toBe(false);expect(c.state.completionReminders).toBe(0);
});
test("exhausted verifier selection has no extra reminder allowance",async()=>{
 const c=pending();c.state.candidate=`sha256:${"a".repeat(64)}`;c.state.verifier=null;c.state.verifierRequests=1;
 const request=input();request.tools={...request.tools,repair_plan:tool({name:"repair_plan",schema:z.object({}),execute:async()=>"plan"})};
 const stream=await c.middleware.wrapStream!({input:request,model},async()=>stop());
 const events=[];for await(const e of stream)events.push(e);expect(events.some(e=>e.type==="tool-call")).toBe(false);
});
