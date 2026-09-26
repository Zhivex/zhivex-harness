import {test,expect} from "bun:test";
import {createQwen} from "@zhivex-ai/qwen";
import {withQwenHostedPolicy} from "../src/providers/qwen-hosted-policy.js";
import {modelReasoningEfforts} from "../src/providers/reasoning.js";

for (const streaming of [false,true]) test(`Kimi K3 uses documented thinking-only Chat route, stream=${streaming}`,async()=>{
 const bodies: Record<string,unknown>[]=[];const urls:string[]=[];
 const fetcher=Object.assign(async(url:unknown,init?:RequestInit)=>{
   urls.push(String(url));bodies.push(JSON.parse(String(init?.body)));
   const r={id:"fixture",model:"kimi-k3",choices:[{index:0,message:{role:"assistant",content:"OK"},delta:{content:"OK"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
   return streaming?new Response(`data: ${JSON.stringify(r)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}}):Response.json(r);
 },{preconnect:()=>{}}) as typeof fetch;
 const model=withQwenHostedPolicy(createQwen({apiKey:"fixture",fetch:fetcher})("kimi-k3"));
 const input={messages:[{role:"user" as const,parts:[{type:"text" as const,text:"OK"}]}]};
 if(streaming)for await(const _ of await model.stream!(input)){}else await model.generate(input);
 expect(urls[0]).toEndWith("/chat/completions");expect(bodies[0]!.enable_thinking).toBe(true);
 expect(modelReasoningEfforts("qwen","kimi-k3")).toEqual(["default"]);
 await expect(model.generate({...input,reasoning:{effort:"none"}})).rejects.toThrow("default thinking");
 await expect(model.generate({...input,providerOptions:{apiMode:"responses"}})).rejects.toThrow("Chat Completions");
 expect(urls).toHaveLength(1);
});
