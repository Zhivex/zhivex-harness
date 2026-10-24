import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTextMessage, wrapLanguageModel, type ModelMessage } from "@zhivex-ai/core";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import { createHarness, runHarness } from "../src/runtime/harness.js";

// Offline replay of scripts/live-continuity-smoke.ts. It captures the exact
// compacted context each phase sends to the model.
//
// Live certification of v1.6.1 and v1.6.2 (runs 40092048415, 40099658228 and
// 40100307698): meta failed phase 1 on its first attempt in 3 of 6 attempts.
// Twice it returned its phase-0 answer byte for byte (ORCHID-742 /
// diagnose-parser), once it called read_task. The only difference in the
// phase-1 request from v1.6.0 was the "[before later user messages] " prefix
// that #248 put in front of each recent entry. With the earlier rendering,
// meta passed phase 1 on the first attempt in all 8 certification runs from
// 1.4.0-rc.6 through 1.6.0. Keep recent entries starting with their role label
// and keep the phase-1 context the same as the rendering those runs certified.
const objectives = ["diagnose-parser", "design-cache", "review-api", "profile-parser", "implement-cache", "audit-contract"];
const finalPrompt = "Return one JSON object with exactly codename, compatibility, rejectedApproach, objective. Recover the first three values from prior conversation and set objective to the most recent active project objective stated by the user earlier in the conversation. This reporting request and temporary presentation discussion do not change the project objective. Do not use tools. No prose.";
const noise = (): ModelMessage[] => Array.from({ length: 6 }, (_, i) => createTextMessage(i % 2 ? "assistant" : "user",
  i % 2 ? "Temporary observation recorded; no change to project facts or objective." : "Temporary discussion: presentation wording is nonbinding; project facts and objective remain unchanged."));
const summaryText = (input: ModelMessage[]) => {
  const text = input.flatMap(message => message.parts).map(part => part.type === "text" ? part.text : "")
    .find(value => value.includes('"strategy":"bounded-evidence-'));
  expect(text).toBeDefined();
  return text!.slice(text!.indexOf("{"));
};
const answer = (phase: number) => JSON.stringify({ codename: phase ? "ORCHID-913" : "ORCHID-742",
  compatibility: "keep-public-api", rejectedApproach: "schema-rewrite", objective: objectives[phase] });
// sha256 of the phase-1 compacted envelope produced by 1718361 (v1.6.0, before
// #248). Live phase-1 input was 1617 tokens there and 1628 with the prefix.
const CERTIFIED_PHASE_1_ENVELOPE = "524c4e567aa4c57c20501760f15d479c9577da1ec4d44597b02d55e0a7fbdcc5";

test.each(["qwen", "meta"] as const)("%s: recent entries stay role-labelled and phase 1 keeps the certified context", async provider => {
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
      const envelope = summaryText(input);
      const state = JSON.parse(envelope) as { steering: string[]; recent?: string[] };
      for (const entry of state.recent ?? []) expect(entry).toMatch(/^(?:assistant|tool|Untrusted semantic recollection)[ :(]/);
      expect(envelope).not.toContain("[before later user messages]");
      const change = state.steering.findIndex(entry => entry.startsWith(`Change the active objective to ${objectives[phase]}.`));
      expect(change).toBeGreaterThan(0);
      expect(envelope).not.toContain(`\\"objective\\":\\"${objectives[phase]}\\"`);
      if (phase === 1) {
        expect(createHash("sha256").update(envelope).digest("hex")).toBe(CERTIFIED_PHASE_1_ENVELOPE);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
