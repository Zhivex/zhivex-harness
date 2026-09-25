import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { type ModelMessage, type StreamEvent } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { normalizeQwenReasoning, coalesceQwenReasoning } from "../src/context/qwen-reasoning.js";
import { createHarness, runHarness } from "../src/runtime/harness.js";

const fragment = (text: string) => ({type:"provider-data" as const,provider:"qwen",data:{type:"reasoning_content",reasoningContent:text}});

test("normalization is lossless, idempotent, immutable and respects opaque barriers", () => {
  const opaque = {...fragment("signed"),data:{...fragment("signed").data,signature:"preserve"}};
  const messages: ModelMessage[] = [{role:"assistant",parts:[fragment("α"),fragment("β"),opaque,fragment("γ"),
    {type:"tool-call",toolCall:{id:"call",name:"read_file",input:{path:"a"}}},fragment("δ")] }];
  const original = structuredClone(messages);
  const result = normalizeQwenReasoning(messages);
  expect(result[0]!.parts).toEqual([fragment("αβ"),opaque,fragment("γ"),original[0]!.parts[4]!,fragment("δ")]);
  expect(messages).toEqual(original);
  expect(normalizeQwenReasoning(result)).toEqual(result);
});

test("stream coalescing preserves tool order and bounds the aggregation buffer", async () => {
  const events: StreamEvent[] = [...Array.from({length:18000},()=>fragment("x")),
    {type:"text-delta",textDelta:"answer"},{type:"finish",finishReason:"stop"}];
  const output: StreamEvent[] = [];
  for await (const event of coalesceQwenReasoning((async function*(){yield* events;})())) output.push(event);
  expect(output).toHaveLength(4);
  expect(output.slice(-2)).toEqual(events.slice(-2));
  expect(output.slice(0,2).map(e=>e.type === "provider-data" ? (e.data as {reasoningContent:string}).reasoningContent : "").join("")).toBe("x".repeat(18000));
});

test("fragment-heavy saved history and new Qwen tool turns fit without trimming reasoning or tool results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"qwen-reasoning-"));
  await writeFile(path.join(root,"a.txt"),"evidence");
  const pieces = Array.from({length:1200},()=>fragment("reasoning "));
  const messages: ModelMessage[] = [{role:"user",parts:[{type:"text",text:"Review the repository."}]},
    {role:"assistant",parts:[...pieces,{type:"tool-call",toolCall:{id:"old",name:"read_file",input:{path:"a.txt"}}}]},
    {role:"tool",parts:[{type:"tool-result",toolResult:{toolCallId:"old",toolName:"read_file",output:{content:"evidence"},isError:false}}]}];
  const original = structuredClone(messages);
  const model = createMockLanguageModel({streamEvents:[
    [...pieces,{type:"tool-call",toolCall:{id:"new",name:"read_file",input:{path:"a.txt"}}},{type:"finish",finishReason:"tool-calls"}],
    [{type:"text-delta",textDelta:"done"},{type:"finish",finishReason:"stop"}]
  ]});
  const harness = await createHarness({workspace:root,provider:"qwen",model:"qwen3.8-flash",modelInstance:model,store:createInMemoryAgentRunStore(),subagentProfiles:[],unlimitedTokens:true});
  try {
    const result = await runHarness(harness,{messages});
    expect(result.status).toBe("completed");
    expect(messages).toEqual(original);
    const reasoning = result.messages.flatMap(m=>m.parts).filter(p=>p.type === "provider-data");
    expect(reasoning).toHaveLength(2);
    for (const part of reasoning) expect(part).toEqual(fragment("reasoning ".repeat(1200)));
    expect(result.toolResults.some(r=>r.toolCallId === "new" && !r.isError)).toBe(true);
  } finally { await harness.close(); await rm(root,{recursive:true,force:true}); }
});


test("transport failure preserves already received fragments and still propagates", async () => {
  const failure = new Error("transport failed");
  const events = (async function*(){ yield fragment("partial"); throw failure; })();
  const received: StreamEvent[] = [];
  try { for await (const event of coalesceQwenReasoning(events)) received.push(event); throw new Error("expected rejection"); }
  catch (error) { expect(error).toBe(failure); }
  expect(received).toEqual([fragment("partial")]);
});

test("normalizing a legacy approval checkpoint preserves the decision and original state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"qwen-approval-reasoning-"));
  const model = createMockLanguageModel({streamEvents:[
    [fragment("abc"),{type:"tool-call",toolCall:{id:"edit",name:"apply_reviewed_edits",input:{changes:[{path:"result.txt",expectedDigest:null,content:"approved"}]}}},{type:"finish",finishReason:"tool-calls"}],
    [{type:"text-delta",textDelta:"done"},{type:"finish",finishReason:"stop"}]
  ]});
  const harness = await createHarness({workspace:root,provider:"qwen",model:"qwen3.8-flash",modelInstance:model,store:createInMemoryAgentRunStore(),subagentProfiles:[],unlimitedTokens:true});
  try {
    const waiting = await runHarness(harness,{prompt:"Make the requested edit."});
    expect(waiting.status).toBe("waiting_approval");
    const state = structuredClone(waiting.state);
    state.messages = state.messages.map(m=>({...m,parts:m.parts.flatMap(p=>p.type === "provider-data" && p.provider === "qwen" ? [fragment("a"),fragment("b"),fragment("c")] : [p])}));
    const before = structuredClone(state);
    const result = await runHarness(harness,{state,approvals:state.pendingApprovals.map(a=>({provider:a.provider,approvalRequestId:a.id,approve:true}))});
    expect(state).toEqual(before);
    expect(result.status).toBe("completed");
    expect(result.toolResults.some(r=>r.toolCallId === "edit" && !r.isError)).toBe(true);
  } finally { await harness.close(); await rm(root,{recursive:true,force:true}); }
});
