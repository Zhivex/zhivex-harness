import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTextMessage, wrapLanguageModel, type ModelMessage } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";

// Offline replay of scripts/live-continuity-smoke.ts (v1.6.0 live certification,
// meta phase 5 and qwen phase 2): after compaction the model repeated its
// previous JSON answer, so its objective was the one the user had replaced.
// The summary listed that earlier reply with nothing saying a newer user
// objective followed it.
const objectives = ["diagnose-parser", "design-cache", "review-api", "profile-parser", "implement-cache", "audit-contract"];
const finalPrompt = "Return one JSON object with exactly codename, compatibility, rejectedApproach, objective. Recover the first three values from prior conversation and set objective to the most recent active project objective stated by the user earlier in the conversation. This reporting request and temporary presentation discussion do not change the project objective. Do not use tools. No prose.";
const noise = (): ModelMessage[] => Array.from({ length: 6 }, (_, i) => createTextMessage(i % 2 ? "assistant" : "user",
  i % 2 ? "Temporary observation recorded; no change to project facts or objective." : "Temporary discussion: presentation wording is nonbinding; project facts and objective remain unchanged."));
const summaryState = (input: ModelMessage[]) => {
  const text = input.flatMap(message => message.parts).map(part => part.type === "text" ? part.text : "")
    .find(value => value.includes('"strategy":"bounded-evidence-'));
  expect(text).toBeDefined();
  return JSON.parse(text!.slice(text!.indexOf("{"))) as { steering: string[]; recent?: string[] };
};
const answer = (phase: number) => JSON.stringify({ codename: phase ? "ORCHID-913" : "ORCHID-742",
  compatibility: "keep-public-api", rejectedApproach: "schema-rewrite", objective: objectives[phase] });

test.each(["qwen", "meta"] as const)("%s: compacted exchanges that predate a later user objective are marked as earlier", async provider => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-continuity-chronology-"));
  let session: { messages: ModelMessage[]; metadata?: Record<string, unknown> } = { messages: [] };
  try {
    for (let phase = 0; phase < objectives.length; phase++) {
      let input: ModelMessage[] = [];
      const model = wrapLanguageModel(createMockLanguageModel({ provider, streamEvents: [
        [{ type: "text-delta", textDelta: answer(phase) }, { type: "finish", finishReason: "stop" }]
      ] }), [{ name: "capture", wrapStream: async (context, next) => { input = structuredClone(context.input.messages); return next(); } }]);
      const history = [...session.messages, createTextMessage("user", phase
        ? `Change the active objective to ${objectives[phase]}. ${phase === 1 ? "Correction: project codename is now ORCHID-913, replacing ORCHID-742." : "Keep the corrected project codename."} Preserve compatibility and the rejected approach; this replaces the previous objective.`
        : "Project codename: ORCHID-742. Required compatibility: keep-public-api. Rejected approach: schema-rewrite. Active project objective: diagnose-parser. Retain these project facts for later turns."),
        ...noise(), createTextMessage("user", finalPrompt)];
      // A fresh harness per phase and a JSON round trip stand in for the process restart.
      const harness = await createHarness({ provider, workspace: root, stateDirectory: path.join(root, "state"), modelInstance: model,
        subagentProfiles: [], toolNames: ["read_task"], requireVerifiedDelivery: false, projectContext: false, maxSteps: 2,
        maxInputTokens: 24_000, maxOutputTokens: 8192, maxTotalTokens: 32_192,
        compactionMaxMessages: 5, compactionKeepRecentMessages: 2, compactionMaxEstimatedInputTokens: 12_000 });
      try {
        const result = await runHarness(harness, { messages: history, metadata: (session.metadata ?? {}) as never, maxTokens: 8192 });
        expect(result.status).toBe("completed");
        expect(result.state.compactions?.length).toBe(1);
        const saved = (await harness.store.load(result.state.runId, result.state.scope))!;
        session = JSON.parse(JSON.stringify({ messages: saved.messages, metadata: saved.metadata }));
      } finally { await harness.close(); }
      if (!phase) continue;
      const state = summaryState(input);
      const change = state.steering.findIndex(entry => entry.startsWith(`Change the active objective to ${objectives[phase]}.`));
      expect(change).toBeGreaterThan(0);
      for (const stale of objectives.slice(0, phase)) {
        for (const entry of (state.recent ?? []).filter(value => value.includes(`"objective":"${stale}"`))) {
          expect(entry.startsWith("[before later user messages] assistant: ")).toBe(true);
        }
      }
      expect(JSON.stringify(state)).not.toContain(`\\"objective\\":\\"${objectives[phase]}\\"`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
