import {expect, test} from "bun:test";
import {z} from "zod";
import {tool} from "@zhivex-ai/core";
import {QWEN_TOKEN_PLAN_BASE_URL} from "@zhivex-ai/qwen";
import {DEFAULT_PROVIDER_REGISTRY} from "../src/providers/providers.js";

for (const modelId of ["qwen3.8-max", "qwen3.8-flash"]) {
 for (const apiMode of ["chat","responses"] as const) for (const streaming of [false,true]) test(`Token Plan ${modelId} ${apiMode} ${streaming ? "stream" : "generate"} sends callable tools and receipts`, async () => {
  const original = globalThis.fetch;
  const requests: Record<string,any>[] = [];
  globalThis.fetch = Object.assign(async (url:unknown, init?:RequestInit) => {
   expect(String(url)).toBe(`${QWEN_TOKEN_PLAN_BASE_URL}/${apiMode === "chat" ? "chat/completions" : "responses"}`);
   expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-sp-fixture-only");
   const body = JSON.parse(String(init?.body)); requests.push(body);
   if (apiMode === "responses") {
    const item = requests.length === 1 ? {type:"function_call",id:"fc_fixture",call_id:"call_fixture",name:"read_fixture",arguments:"{}",status:"completed"}
     : {type:"message",role:"assistant",content:[{type:"output_text",text:"done"}]};
    const response={id:"resp_fixture",status:"completed",output:[item]};
    return streaming ? new Response([{type:"response.output_item.done",item},{type:"response.completed",response}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}}) : Response.json(response);
   }
   const calls = [{index:0,id:"call_fixture",type:"function",function:{name:"read_fixture",arguments:"{}"}}];
   const message = requests.length === 1 ? {role:"assistant",content:null,tool_calls:calls} : {role:"assistant",content:"done"};
   const reason = requests.length === 1 ? "tool_calls" : "stop";
   return streaming ? new Response(`data: ${JSON.stringify({id:"fixture",choices:[{index:0,delta:message,finish_reason:reason}]})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}})
    : Response.json({id:"fixture",choices:[{message,finish_reason:reason}]});
  },{preconnect:original.preconnect}) as typeof fetch;
  try {
   const model=DEFAULT_PROVIDER_REGISTRY.createModel({provider:"qwen",model:modelId},{DASHSCOPE_API_KEY:"sk-sp-fixture-only",QWEN_BASE_URL:QWEN_TOKEN_PLAN_BASE_URL});
   const tools={read_fixture:tool({name:"read_fixture",schema:z.object({}),execute:()=>"fixture"})};
   const messages:any[]=[{role:"user",parts:[{type:"text",text:"Read the fixture"}]}];
   if(streaming) {
    const parts:any[]=[];
    for await(const event of await model.stream!({messages,tools,providerOptions:{apiMode}}))if(event.type==="tool-call")parts.push({type:"tool-call",toolCall:event.toolCall});
    expect(parts).toHaveLength(1); messages.push({role:"assistant",parts});
   } else {const result=await model.generate({messages,tools,providerOptions:{apiMode}}); expect(result.messages).toBeDefined(); messages.push(...result.messages!);}
   messages.push({role:"tool",parts:[{type:"tool-result",toolResult:{toolCallId:"call_fixture",toolName:"read_fixture",output:"fixture",isError:false}}]});
   if(streaming)await Array.fromAsync(await model.stream!({messages,tools,providerOptions:{apiMode}}));else await model.generate({messages,tools,providerOptions:{apiMode}});
   expect(requests).toHaveLength(2);
   expect(requests[0]!.model).toBe(modelId);
   expect((apiMode === "chat" ? requests[0]!.tools[0].function.name : requests[0]!.tools[0].name)).toBe("read_fixture");
   if(apiMode === "chat") expect(requests[1]!.messages.at(-1)).toMatchObject({role:"tool",tool_call_id:"call_fixture"});
   else expect(requests[1]!.input.at(-1)).toMatchObject({type:"function_call_output",call_id:"call_fixture"});
  } finally {globalThis.fetch=original;}
 });
}
