/** Offline synthetic fixtures. Emits booleans only, never fixture payloads. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, createRedactionPolicy, runAgent, streamAgent } from "@zhivex-ai/agents";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createFileAgentRunStore, createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";

let defectObserved = false;
for (const storage of ["memory", "file-reopened"] as const) {
  for (const mode of ["generate", "stream"] as const) {
    for (const rejectAfterRedaction of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "zhx-redaction-fixture-"));
      try {
        const fixture = "fixture_sensitive_123456789";
        const text = `token: ${fixture}`;
        const store = storage === "memory" ? createInMemoryAgentRunStore() : createFileAgentRunStore({directory});
        const redaction = createRedactionPolicy();
        let downstreamSawFixture = false;
        const agent = createAgent({ id: "redaction-fixture", store,
          model: createMockLanguageModel({
            responses:[{text,messages:[{role:"assistant",parts:[{type:"text",text}]}],finishReason:"stop"}],
            streamEvents:[[{type:"text-delta",textDelta:text},{type:"finish",finishReason:"stop"}]]
          }),
          outputGuardrails:[redaction.outputGuardrail,({output})=>{
            downstreamSawFixture = output.outputText.includes(fixture);
            return rejectAfterRedaction ? {triggered:true,reason:"SYNTHETIC_REJECTION"} : undefined;
          }]
        });
        const input = {runId:`redaction-${mode}-${rejectAfterRedaction}`,prompt:"synthetic fixture",scope:{tenantId:"fixture"}};
        let streamedText = "";
        const result = mode === "generate" ? await runAgent(agent,input) : await (async()=>{
          const stream = streamAgent(agent,input);
          for await(const event of stream.eventStream) if(event.type === "text-delta") streamedText += event.textDelta;
          return stream.collect();
        })();
        const reopened = storage === "memory" ? store : createFileAgentRunStore({directory});
        const saved = await reopened.load(result.state.runId,input.scope);
        const evidence = {storage,mode,rejectAfterRedaction,downstreamSawFixture,
          returnedTextContainsFixture:result.outputText.includes(fixture),
          returnedStateTextContainsFixture:result.state.outputText.includes(fixture),
          persistedTextContainsFixture:saved?.outputText.includes(fixture) ?? null,
          persistedMessagesContainFixture:JSON.stringify(saved?.messages).includes(fixture),
          persistedStepsContainFixture:JSON.stringify(saved?.steps).includes(fixture),
          ...(mode === "stream" ? {streamedBeforeOutputGuardrailContainsFixture:streamedText.includes(fixture)} : {})
        };
        defectObserved ||= evidence.returnedTextContainsFixture || evidence.returnedStateTextContainsFixture || evidence.persistedTextContainsFixture === true || evidence.persistedMessagesContainFixture || evidence.persistedStepsContainFixture;
        console.log(JSON.stringify(evidence));
      } finally { await rm(directory,{recursive:true,force:true}); }
    }
  }
}
// A future consumer can require repaired final output/state without treating
// pre-guardrail streaming chunks as proof of an undocumented streaming guarantee.
if (process.argv.includes("--require-fixed") && defectObserved) process.exitCode = 1;
