import {expect,test} from "bun:test";
import {tool} from "@zhivex-ai/agents";
import {createMockLanguageModel} from "@zhivex-ai/agents/testing";
import {z} from "zod";
import {wrapLanguageModel, type ModelGenerateInput, type ToolSet} from "@zhivex-ai/core";
import {createRepairController,REPAIR_CONTROLLER_KEY} from "../src/repair-controller.js";
const execute=async(tools:ToolSet,name:string,input:unknown)=>{
 const t=tools[name]!;if(!('execute' in t))throw new Error('missing fixture execute');return t.execute!(input as never,{} as never);
};
const definitions={
 apply_reviewed_edits:tool({name:"apply_reviewed_edits",schema:z.object({}),execute:async():Promise<string>=>{throw new Error("must not execute");}}),
 repair_plan:tool({name:"repair_plan",schema:z.object({}),execute:async()=>({})}),
 read_task:tool({name:"read_task",schema:z.object({}),execute:async()=>"task"}),
 read_files:tool({name:"read_files",schema:z.object({}),execute:async():Promise<string>=>{throw new Error("must not read while plan required");}})
};
test("missing-plan rejection focuses the next turn and persists across resume",async()=>{
 const c=createRepairController({},true),tools=c.wrapTools(definitions);
 await expect(execute(tools,"apply_reviewed_edits",{})).rejects.toThrow("REPAIR_PLAN_REQUIRED");
 const restored=createRepairController({[REPAIR_CONTROLLER_KEY]:c.snapshot()},true);
 const request:ModelGenerateInput={messages:[],tools:definitions,reasoning:{effort:"none"}};
 await restored.middleware.wrapGenerate!({model:createMockLanguageModel({provider:"qwen"}),input:request},async()=>({finishReason:"stop"}));
 expect(Object.keys(request.tools!)).toEqual(["repair_plan","read_task"]);
 expect(request.toolChoice).toEqual({type:"tool",toolName:"repair_plan"});
 expect(restored.completionPending()).toBe(true);
 await expect(execute(restored.wrapTools(definitions),"read_files",{})).rejects.toThrow("REPAIR_PLAN_REQUIRED");
 await execute(restored.wrapTools(definitions),"repair_plan",{verifier:{command:"node",args:["verify.mjs"],purpose:"assert fix"}});
 const next:ModelGenerateInput={messages:[],tools:definitions};
 await restored.middleware.wrapGenerate!({model:createMockLanguageModel(),input:next},async()=>({finishReason:"stop"}));
 expect(Object.keys(next.tools!)).toContain("apply_reviewed_edits");
});
test("planning attempts remain bounded after restoring the controller",async()=>{
 const c=createRepairController({},true);await expect(execute(c.wrapTools(definitions),"apply_reviewed_edits",{})).rejects.toThrow("REPAIR_PLAN_REQUIRED");
 for(let n=0;n<2;n++)await c.middleware.wrapGenerate!({model:createMockLanguageModel(),input:{messages:[],tools:definitions}},async()=>({finishReason:"stop"}));
 const restored=createRepairController({[REPAIR_CONTROLLER_KEY]:c.snapshot()},true);
 await expect(restored.middleware.wrapGenerate!({model:createMockLanguageModel(),input:{messages:[],tools:definitions}},async()=>({}))).rejects.toThrow("REPAIR_PLAN_MISSING");
});

import {createModelBudget} from "../src/model-budget.js";
test("missing-plan recovery uses reserved tokens after resume without increasing the total budget",async()=>{
 const c=createRepairController({},true);
 await expect(execute(c.wrapTools(definitions),"apply_reviewed_edits",{})).rejects.toThrow("REPAIR_PLAN_REQUIRED");
 const restored=createRepairController({[REPAIR_CONTROLLER_KEY]:c.snapshot()},true);
 const budget=createModelBudget({inputTokens:10000,outputTokens:1000},{
  saved:{inputTokens:7000,outputTokens:700,cachedInputTokens:0,modelCalls:1,usageComplete:true},
  closure:()=>restored.closure()});
 let offered:string[]=[];let cap:number|undefined;
 const base=createMockLanguageModel({responses:[{finishReason:"tool-calls",usage:{inputTokens:400,outputTokens:10,totalTokens:410}}]});
 const generate=base.generate;
 base.generate=async input=>{offered=Object.keys(input.tools??{});cap=input.maxTokens;return generate(input);};
 const model=wrapLanguageModel(base,[restored.middleware,budget.middleware]);
 await model.generate({messages:[],tools:definitions,maxTokens:2048});
 expect(offered).toEqual(["repair_plan","read_task"]);
 expect(cap).toBe(300);
 expect(budget.stats.inputTokens).toBe(7400);
 expect(budget.stats.outputTokens).toBe(710);
 expect(budget.stats.usageComplete).toBe(true);
 await expect(execute(restored.wrapTools(definitions),"read_files",{})).rejects.toThrow("REPAIR_PLAN_REQUIRED");
});
test("missing-plan reserve cannot exceed the total input ceiling",async()=>{
 const c=createRepairController({},true);
 await expect(execute(c.wrapTools(definitions),"apply_reviewed_edits",{})).rejects.toThrow("REPAIR_PLAN_REQUIRED");
 const budget=createModelBudget({inputTokens:10000,outputTokens:1000},{
  saved:{inputTokens:10000,outputTokens:0,cachedInputTokens:0,modelCalls:1,usageComplete:true},closure:()=>c.closure()});
 const model=wrapLanguageModel(createMockLanguageModel(),[c.middleware,budget.middleware]);
 await expect(model.generate({messages:[],tools:definitions})).rejects.toThrow("INPUT_TOKEN_BUDGET");
 expect(budget.stats.modelCalls).toBe(1);
});
