/** Offline synthetic fixture. Emits booleans only, never the fixture payload. */
import { createAgent, createRedactionPolicy, runAgent } from "@zhivex-ai/agents";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";

for (const rejectAfterRedaction of [false, true]) {
  const secret = "fixture_sensitive_123456789";
  const text = `token: ${secret}`;
  const store = createInMemoryAgentRunStore();
  const redaction = createRedactionPolicy();
  let downstreamSawSecret = false;
  const agent = createAgent({ id: "redaction-fixture", store,
    model: createMockLanguageModel({responses:[{text,messages:[{role:"assistant",parts:[{type:"text",text}]}],finishReason:"stop"}]}),
    outputGuardrails:[redaction.outputGuardrail,({output})=>{
      downstreamSawSecret = output.outputText.includes(secret);
      return rejectAfterRedaction ? {triggered:true,reason:"SYNTHETIC_REJECTION"} : undefined;
    }]
  });
  const result=await runAgent(agent,{runId:`redaction-${rejectAfterRedaction}`,prompt:"synthetic fixture",scope:{tenantId:"fixture"}});
  const saved=await store.load(result.state.runId,{tenantId:"fixture"});
  console.log(JSON.stringify({rejectAfterRedaction,downstreamSawSecret,returnedTextContainsSecret:result.outputText.includes(secret),returnedStateContainsSecret:JSON.stringify(result.state).includes(secret),persistedStateContainsSecret:JSON.stringify(saved).includes(secret)}));
}
