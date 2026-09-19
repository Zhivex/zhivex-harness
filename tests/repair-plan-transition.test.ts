import {expect,test} from "bun:test";
import {tool} from "@zhivex-ai/agents";
import {createMockLanguageModel} from "@zhivex-ai/agents/testing";
import {z} from "zod";
import type {ModelGenerateInput,ToolSet} from "@zhivex-ai/core";
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
