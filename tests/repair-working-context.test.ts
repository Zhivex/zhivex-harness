import {expect,test} from "bun:test";
import {tool} from "@zhivex-ai/agents";
import {createMockLanguageModel} from "@zhivex-ai/agents/testing";
import {z} from "zod";
import type {ModelGenerateInput,ToolSet} from "@zhivex-ai/core";
import {createRepairController} from "../src/runtime/repair-controller.js";
import {createRepairProgress,REPAIR_PROGRESS_KEY} from "../src/runtime/repair-progress.js";
const execute=async(tools:ToolSet,name:string,input:unknown)=>{
 const t=tools[name]!;if(!('execute' in t))throw new Error('missing execute');return t.execute!(input as never,{} as never);
};
test("restored compacted working context includes the actual enforced plan and remaining allowances",async()=>{
 const usage=()=>({inputTokens:700,outputTokens:0});const limits={inputTokens:1000,outputTokens:1000};
 const progress=createRepairProgress(usage,limits);
 const definitions={repair_plan:tool({name:"repair_plan",schema:z.any(),execute:async()=>({})}),read_files:tool({name:"read_files",schema:z.any(),execute:async()=>({files:[]})})};
 const tools=progress.wrapTools(definitions);
 await execute(tools,"repair_plan",{paths:["src/./fix.ts"]});
 await expect(execute(tools,"read_files",{files:[{path:"src/outside.ts"}]})).rejects.toThrow("REPAIR_PLAN_SCOPE");
 const metadata={[REPAIR_PROGRESS_KEY]:progress.snapshot()};
 const restored=createRepairProgress(usage,limits,metadata);
 const controller=createRepairController(metadata,false,{progressContext:()=>restored.workingContext()});
 const input:ModelGenerateInput={messages:[{role:"user",parts:[{type:"text",text:"Compacted summary without file paths."}]}]};
 await controller.middleware.wrapGenerate!({input,model:createMockLanguageModel()},async()=>({}));
 const text=input.messages.flatMap(m=>m.parts).filter(p=>p.type==="text").map(p=>p.text).join("\n");
 expect(text).toContain('"plannedPaths":["src/fix.ts"]');
 expect(text).toContain('"closureReadsRemaining":4');
 expect(text).toContain('"closureCommandsRemaining":3');
 await expect(execute(restored.wrapTools(definitions),"read_files",{files:[{path:"src/outside.ts"}]})).rejects.toThrow("REPAIR_PLAN_SCOPE");
});
