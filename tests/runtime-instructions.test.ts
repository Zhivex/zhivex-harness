import { expect, test } from "bun:test";
import { wrapLanguageModel, type ModelMessage } from "@zhivex-ai/core";
import { DEFAULT_PROVIDER_REGISTRY } from "../src/providers/providers.js";
import { resolveHarnessConfig } from "../src/runtime/config.js";
import { createCheckpointTokenCap } from "../src/runtime/runtime-policy.js";
import { createOciDelivery, OCI_DELIVERY_KEY } from "../src/runtime/oci-delivery.js";

for (const kind of ["budget", "oci"] as const) for (const mode of ["generate", "stream"] as const) {
  test(`${kind} ${mode} host instructions remain valid after Anthropic tool results`, async () => {
    const original = globalThis.fetch;
    let request: any;
    globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (mode === "generate") return Response.json({ id: "fixture", type: "message", role: "assistant", content: [{type:"text",text:"done"}], stop_reason: "end_turn", usage });
      return new Response(`event: message_start\ndata: ${JSON.stringify({message:{usage}})}\n\nevent: message_delta\ndata: ${JSON.stringify({delta:{stop_reason:"end_turn"},usage})}\n\nevent: message_stop\ndata: {}\n\n`);
    }, {preconnect:original.preconnect});
    try {
      const messages: ModelMessage[] = [
        {role:"system",parts:[{type:"text",text:"Original host instruction"}]},
        {role:"user",parts:[{type:"text",text:"Inspect fixture"}]},
        {role:"assistant",parts:[{type:"tool-call",toolCall:{id:"fixture-call",name:"read_file",input:{path:"fixture"}}}]},
        {role:"tool",parts:[{type:"tool-result",toolResult:{toolCallId:"fixture-call",toolName:"read_file",output:"fixture",isError:false}}]}
      ];
      const snapshot = structuredClone(messages);
      const middleware = kind === "budget"
        ? createCheckpointTokenCap(resolveHarnessConfig({maxInputTokens:60000,maxOutputTokens:8192,maxTotalTokens:68192}).budget,async()=>undefined,true,{closeOnBudget:true,initialUsage:{inputTokens:42001,outputTokens:0,totalTokens:42001}})
        : createOciDelivery(async()=>false,{[OCI_DELIVERY_KEY]:{reminders:1,declined:false}}).middleware;
      const model = wrapLanguageModel(DEFAULT_PROVIDER_REGISTRY.createModel({provider:"anthropic",model:"claude-sonnet-5-5"},{ANTHROPIC_API_KEY:"fixture-secret"}),[middleware]);
      if (mode === "generate") await model.generate({messages});
      else for await (const _event of await model.stream!({messages})) { /* Drain transport. */ }
      expect(request).toBeDefined();
      expect(JSON.stringify(request.system)).toContain("Original host instruction");
      expect(JSON.stringify(request.system)).toContain(kind === "budget" ? "cumulative token budget" : "patch");
      expect(request.messages.map((m:any)=>m.role)).toEqual(["user","assistant","user"]);
      expect(request.messages[2].content[0]).toMatchObject({type:"tool_result",tool_use_id:"fixture-call"});
      expect(messages).toEqual(snapshot);
    } finally { globalThis.fetch = original; }
  });
}

import { mkdtemp, rm } from "node:fs/promises";
import { createHarness, runHarness } from "../src/runtime/harness.js";
import { withFreshSystemInstructions } from "../src/runtime/runtime-instructions.js";

test("fresh conversation correction keeps system instructions before loaded memory", async () => {
  const root = await mkdtemp('/tmp/har-fresh-instructions-');
  const original = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('event: message_start\ndata: {"message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"done"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {}\n\n');
  }, {preconnect:original.preconnect});
  const harness = await createHarness({workspace:root,provider:'anthropic',model:'claude-sonnet-5-5',env:{ANTHROPIC_API_KEY:'fixture-secret'},requireVerifiedDelivery:false,projectContext:false,subagentProfiles:[],memory:{load:()=>[{role:'assistant',parts:[{type:'text',text:'Remembered context, not instructions'}]}]}});
  try {
    const first = await runHarness(harness,{prompt:'First request',system:'Preserve host constraint'});
    expect(first.status).toBe('completed');
    const snapshot=structuredClone(first.state.messages);
    const second=await runHarness(harness,{messages:[...first.state.messages,{role:'user',parts:[{type:'text',text:'Correction: preserve earlier work'}]}]});
    expect(second.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((m:any)=>m.role==='system')).toBe(false);
    expect(JSON.stringify(requests[1].system)).toContain('Preserve host constraint');
    expect(JSON.stringify(requests[1].system).split('You are Zhivex Harness').length-1).toBe(1);
    expect(JSON.stringify(requests[1].system)).not.toContain('Remembered context');
    expect(JSON.stringify(requests[1].messages)).toContain('Remembered context');
    expect(JSON.stringify(requests[1].messages)).toContain('First request');
    expect(JSON.stringify(requests[1].messages)).toContain('Correction: preserve earlier work');
    expect(first.state.messages).toEqual(snapshot);
  } finally {globalThis.fetch=original;await harness.close();await rm(root,{recursive:true,force:true});}
});

test("fresh instruction normalization does not move opaque or later system blocks",()=>{
 const opaque={messages:[{role:'system' as const,parts:[{type:'provider-data' as const,provider:'anthropic',data:{type:'compaction',signature:'fixture'}}]}]};
 expect(withFreshSystemInstructions(opaque)).toBe(opaque);
 const later={messages:[{role:'user' as const,parts:[{type:'text' as const,text:'request'}]},{role:'system' as const,parts:[{type:'text' as const,text:'later'}]}]};
 expect(withFreshSystemInstructions(later)).toBe(later);
});

test("fresh instruction deduplication preserves changed policy and extra operator constraints",()=>{
 const message=(text:string)=>({role:'system' as const,parts:[{type:'text' as const,text}]});
 const input={system:'Current operator',messages:[message('Current host\n\nRetained constraint'),{role:'user' as const,parts:[{type:'text' as const,text:'next'}]}]};
 expect(withFreshSystemInstructions(input,'Current host')).toMatchObject({system:'Current operator\n\nRetained constraint'});
 expect(withFreshSystemInstructions(input,'Changed host')).toMatchObject({system:'Current operator\n\nCurrent host\n\nRetained constraint'});
});
