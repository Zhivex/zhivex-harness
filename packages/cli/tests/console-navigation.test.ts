import {test,expect} from "bun:test";
import {navigateConsole,consoleModelChoices} from "../src/cli/console/console-navigation.js";
import {providerAvailability} from "@zhivex-ai/harness/engine";
import type {ConsoleInput} from "../src/cli/console/console-input.js";

test("provider to models navigation preserves back stack and applies only a chosen model", async()=>{
 const pages:string[]=[];
 const answers=["provider","openai",undefined,undefined,"model",{kind:"model",id:"gpt-5.6-luna"},"default"];
 const input={select:async(title:string)=>{pages.push(title);return answers.shift();},question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
 const result=await navigateConsole(input,{entry:"menu",providers:providerAvailability({}),current:{provider:"openai",model:"gpt-5.6-luna"},sessions:async()=>[]});
 expect(result).toEqual({provider:"openai",model:"gpt-5.6-luna",reasoningEffort:"default"});
 expect(pages.slice(0,5).map(p=>p.split("\n")[0])).toEqual(["Zhivex / Menu","Zhivex / Providers","Zhivex / Providers / OpenAI / Models","Zhivex / Providers","Zhivex / Menu"]);
});

test("catalog lists source-backed choices, preserves custom active models and excludes non-chat transports",()=>{
 const choices=consoleModelChoices("openai","gpt-5.6-luna","custom-current");
 expect(choices.find(item=>item.value==="custom-current")?.detail).toContain("Current");
 expect(choices.map(c=>c.value)).toContain("gpt-6-astra");
 expect(choices.every(c=>!/realtime|image|live/.test(c.value))).toBe(true);
 expect(new Set(choices.map(c=>c.value)).size).toBe(choices.length);
});

test("service navigation exposes only host-authorized commands",async()=>{
 let values:unknown[]=[];
 const input={select:async(_title:string,items:{value:unknown}[])=>{values=items.map(i=>i.value);return undefined;},question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
 expect(await navigateConsole(input,{entry:"menu",service:true,providers:[],current:{provider:"service",model:"host"},sessions:async()=>[]})).toBeUndefined();
 expect(values).not.toContain("provider");expect(values).not.toContain("model");
});

test("reasoning escape returns to models without committing either selection", async () => {
 const pages:string[]=[];
 const answers=[{kind:"model",id:"qwen3.8-flash"},undefined,{kind:"model",id:"qwen3.8-max"},"low"];
 const input={select:async(title:string)=>{pages.push(title);return answers.shift();},question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
 const selected=await navigateConsole(input,{entry:"model",providers:providerAvailability({}),current:{provider:"qwen",model:"qwen3.8-flash"},sessions:async()=>[]});
 expect(selected).toEqual({provider:"qwen",model:"qwen3.8-max",reasoningEffort:"low"});
 expect(pages[1]).toContain("Reasoning"); expect(pages[2]).toContain("Models");
});

test("Qwen frontier models appear on the first page even with an older current model",async()=>{
 const pages: {value:unknown;label:string;detail?:string}[][]=[];
 const input={select:async (_title:string,items:{value:unknown;label:string;detail?:string}[])=>{pages.push(items);return undefined;},question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
 await navigateConsole(input,{entry:"model",providers:providerAvailability({}),current:{provider:"qwen",model:"qwen-plus"},sessions:async()=>[]});
 const ids=pages[0]!.map(item=>(item.value as {id:string}).id);
 expect(ids.slice(0,5)).toEqual(["qwen3.8-flash","qwen3.8-max","glm-5.3","deepseek-v4.1-flash","kimi-k3"]);
 expect(pages[0]!.find(item=>(item.value as {id:string}).id==="glm-5.3")?.detail).toContain("Zhipu");
});

test("Anthropic can be selected from the shared provider and model catalog", async () => {
 const prompts: Array<{title:string;values:unknown[]}> = [];
 const answers: unknown[] = ["anthropic",{kind:"model",id:"claude-sonnet-5"},"default"];
 const input = {select:async(title:string,items:readonly {value:unknown}[])=>{
   prompts.push({title,values:items.map(item=>item.value)});
   return answers.shift();
 },question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
 expect(await navigateConsole(input,{entry:"provider",providers:providerAvailability({}),current:{provider:"openai",model:"gpt-6-luna"},sessions:async()=>[]})).toEqual({provider:"anthropic",model:"claude-sonnet-5",reasoningEffort:"default"});
 expect(prompts[0]!.values).toContain("anthropic");
 expect(prompts[1]!.values).toContainEqual({kind:"model",id:"claude-sonnet-5"});
});
