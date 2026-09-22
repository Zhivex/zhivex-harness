import {test,expect} from "bun:test";
import {navigateConsole,consoleModelChoices} from "../src/cli/console/console-navigation.js";
import {providerAvailability} from "../src/runtime/config.js";
import type {ConsoleInput} from "../src/cli/console/console-input.js";

test("provider to models navigation preserves back stack and applies only a chosen model", async()=>{
 const pages:string[]=[];
 const answers=["provider","openai",undefined,undefined,"model",{kind:"model",id:"gpt-5.6-luna"}];
 const input={select:async(title:string)=>{pages.push(title);return answers.shift();},question:async()=>""} as unknown as Pick<ConsoleInput,"select"|"question">;
 const result=await navigateConsole(input,{entry:"menu",providers:providerAvailability({}),current:{provider:"openai",model:"gpt-5.6-luna"},sessions:async()=>[]});
 expect(result).toEqual({provider:"openai",model:"gpt-5.6-luna"});
 expect(pages.slice(0,5).map(p=>p.split("\n")[0])).toEqual(["Zhivex / Menu","Zhivex / Providers","Zhivex / Providers / OpenAI / Models","Zhivex / Providers","Zhivex / Menu"]);
});

test("catalog lists source-backed choices, preserves custom active models and excludes non-chat transports",()=>{
 const choices=consoleModelChoices("openai","gpt-5.6-luna","custom-current");
 expect(choices[0]?.value).toBe("custom-current");
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
