import { expect, test } from "bun:test";
import { createQwen } from "@zhivex-ai/qwen";
import { wrapLanguageModel, type ModelMessage } from "@zhivex-ai/core";
import { qwenLocalContext } from "../src/providers/qwen-context.js";

for (const streaming of [false,true]) test(`Qwen wire request replays compacted context instead of remote history: streaming=${streaming}`, async () => {
  const bodies: Record<string,any>[]=[];
  const fetcher=Object.assign(async (_url:unknown,init?:RequestInit)=>{
    bodies.push(JSON.parse(String(init?.body)));
    const response={id:"resp_new",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:10,output_tokens:1,total_tokens:11}};
    return streaming ? new Response(`data: ${JSON.stringify({type:"response.completed",response})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}}) : Response.json(response);
  },{preconnect:()=>{}}) as typeof fetch;
  const model=wrapLanguageModel(createQwen({apiKey:"fixture",fetch:fetcher})("qwen3.8-flash"),[qwenLocalContext]);
  const messages:ModelMessage[]=[
    {role:"system",parts:[{type:"text",text:"Current project rules"}]},
    {role:"user",parts:[{type:"text",text:"[Compacted conversation context] Keep the current API"}]},
    {role:"assistant",parts:[{type:"text",text:"Working"},{type:"provider-data",provider:"qwen",data:{responseId:"resp_old"}}]},
    {role:"user",parts:[{type:"text",text:"Implement the scoped fix"}]}
  ];
  const original=structuredClone(messages);
  const input={messages,providerOptions:{apiMode:"responses" as const,previous_response_id:"explicit_old"}};
  if(streaming) for await (const _ of await model.stream!(input)) {}
  else await model.generate(input);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.previous_response_id).toBeUndefined();
  expect(JSON.stringify(bodies[0]!.input)).toContain("Keep the current API");
  expect(JSON.stringify(bodies[0]!.input)).toContain("Current project rules");
  expect(messages).toEqual(original);
});
