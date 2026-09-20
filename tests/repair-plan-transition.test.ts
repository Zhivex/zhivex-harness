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

import {createModelBudget,workBudgetReached} from "../src/model-budget.js";
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

for(const required of [true,false])test(`work boundary enters bounded planning only for required delivery=${required}`,async()=>{
 let budget:ReturnType<typeof createModelBudget>;
 const controller=createRepairController({},true,{requireVerifiedDelivery:required,
  workBudgetReached:input=>workBudgetReached(input,budget.stats,{inputTokens:10000,outputTokens:1000})});
 budget=createModelBudget({inputTokens:10000,outputTokens:1000},{saved:{inputTokens:6000,outputTokens:0,cachedInputTokens:0,modelCalls:1,usageComplete:true},closure:()=>controller.closure()});
 const catalog={...definitions,read_files:{...definitions.read_files,description:'Repository exploration context. '.repeat(300)}};
 let offered:string[]=[];
 const base=createMockLanguageModel({responses:[{finishReason:'tool-calls',usage:{inputTokens:300,outputTokens:10,totalTokens:310}}]});
 const generate=base.generate;base.generate=async input=>{offered=Object.keys(input.tools??{});return generate(input);};
 const model=wrapLanguageModel(base,[controller.middleware,budget.middleware]);
 const call=model.generate({messages:[],tools:catalog});
 if(!required){await expect(call).rejects.toThrow('WORK_TOKEN_BUDGET');expect(offered).toEqual([]);return;}
 await call;
 expect(offered).toEqual(['repair_plan','read_task']);expect(controller.state.planRequired).toBe(true);
 expect(budget.stats.inputTokens).toBe(6300);
 await expect(execute(controller.wrapTools(definitions),'read_files',{})).rejects.toThrow('REPAIR_PLAN_REQUIRED');
 const restored=createRepairController({[REPAIR_CONTROLLER_KEY]:controller.snapshot()},true);
 await restored.middleware.wrapGenerate!({model:base,input:{messages:[],tools:definitions}},async()=>({finishReason:'tool-calls'}));
 await expect(restored.middleware.wrapGenerate!({model:base,input:{messages:[],tools:definitions}},async()=>({}))).rejects.toThrow('REPAIR_PLAN_MISSING');
});

for(const boundary of ['work-output','total-input','total-output'] as const)test(`required planning respects ${boundary} boundary`,async()=>{
 let budget:ReturnType<typeof createModelBudget>;
 const c=createRepairController({},true,{requireVerifiedDelivery:true,workBudgetReached:input=>workBudgetReached(input,budget.stats,{inputTokens:10000,outputTokens:1000})});
 budget=createModelBudget({inputTokens:10000,outputTokens:1000},{saved:{inputTokens:boundary==='total-input'?10000:0,outputTokens:boundary==='total-output'?1000:700,cachedInputTokens:0,modelCalls:1,usageComplete:true},closure:()=>c.closure()});
 let calls=0,cap:number|undefined;
 const base=createMockLanguageModel({responses:[{finishReason:'tool-calls',usage:{inputTokens:100,outputTokens:10,totalTokens:110}}]});
 const generate=base.generate;base.generate=async input=>{calls++;cap=input.maxTokens;return generate(input);};
 const model=wrapLanguageModel(base,[c.middleware,budget.middleware]);
 const call=model.generate({messages:[],tools:definitions,maxTokens:2048});
 if(boundary==='work-output'){await call;expect(c.state.planRequired).toBe(true);expect(cap).toBe(300);expect(calls).toBe(1);}
 else{await expect(call).rejects.toThrow(boundary==='total-input'?'INPUT_TOKEN_BUDGET':'OUTPUT_TOKEN_BUDGET');expect(calls).toBe(0);}
});

for (const preplanned of [false, true]) test(`work-boundary reserve persists through plan and resume (preplanned=${preplanned})`, async () => {
 let budget: ReturnType<typeof createModelBudget>;
 const limits = { inputTokens: 10000, outputTokens: 1000 };
 const controller = createRepairController({}, true, { requireVerifiedDelivery: true,
  workBudgetReached: input => workBudgetReached(input, budget.stats, limits) });
 const plan = { verifier: { command: 'node', args: ['verify.mjs'], purpose: 'assert fix' } };
 if (preplanned) await execute(controller.wrapTools(definitions), 'repair_plan', plan);
 budget = createModelBudget(limits, { saved: { inputTokens: 7000, outputTokens: 0,
  cachedInputTokens: 0, modelCalls: 1, usageComplete: true }, closure: () => controller.closure() });
 const base = createMockLanguageModel({ responses: [
  { finishReason: 'tool-calls', usage: { inputTokens: 300, outputTokens: 10, totalTokens: 310 } },
  { finishReason: 'tool-calls', usage: { inputTokens: 300, outputTokens: 10, totalTokens: 310 } }
 ] });
 await wrapLanguageModel(base, [controller.middleware, budget.middleware]).generate({ messages: [], tools: definitions });
 if (!preplanned) await execute(controller.wrapTools(definitions), 'repair_plan', plan);
 const restored = createRepairController({ [REPAIR_CONTROLLER_KEY]: controller.snapshot() }, true);
 expect(restored.closure()).toBe(true);
 const restoredBudget = createModelBudget(limits, { saved: budget.snapshot(), closure: () => restored.closure() });
 await wrapLanguageModel(base, [restored.middleware, restoredBudget.middleware]).generate({ messages: [], tools: definitions });
 expect(restoredBudget.stats.modelCalls).toBe(3);
 expect(restoredBudget.stats.inputTokens).toBe(7600);
 const exhausted = createModelBudget(limits, { saved: { ...restoredBudget.snapshot(), inputTokens: 10000 }, closure: () => restored.closure() });
 await expect(wrapLanguageModel(base, [restored.middleware, exhausted.middleware]).generate({ messages: [], tools: definitions })).rejects.toThrow('INPUT_TOKEN_BUDGET');
});
