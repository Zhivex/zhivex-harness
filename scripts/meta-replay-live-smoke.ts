/** Bounded, opt-in Meta replay check. Prints no prompts, ciphertext or response IDs. */
import assert from "node:assert/strict";
import { tool, type ModelMessage } from "@zhivex-ai/core";
import { z } from "zod";
import { createMetaReplayModel } from "../src/providers/meta-replay.js";
import { sanitizeOperationalError } from "./release-diagnostics.js";

assert.equal(process.env.ZHIVEX_HARNESS_LIVE, "1", "Set ZHIVEX_HARNESS_LIVE=1 for bounded live requests.");
assert(process.env.MODEL_API_KEY, "Missing Meta credentials.");
const modelId = process.env.ZHIVEX_HARNESS_LIVE_META_MODEL ?? "muse-spark-1.3";
const rows: { mode: string; status: string; requests: number; encryptedReplay: boolean }[] = [];
try {
  for (const mode of ["generate", "stream"] as const) {
    let requests = 0, encryptedReplay = false;
    const observedFetch: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.previous_response_id, undefined);
      assert(body.include.includes("reasoning.encrypted_content"));
      if (++requests === 2) {
        encryptedReplay = body.input.some((item: Record<string, unknown>) => item.type === "reasoning" && typeof item.encrypted_content === "string");
        assert(encryptedReplay, "Continuation must include encrypted reasoning.");
      }
      assert(requests <= 2, "Unexpected extra request.");
      return fetch(url, init);
    }, { preconnect: fetch.preconnect });
    const makeModel = () => createMetaReplayModel({ apiKey: process.env.MODEL_API_KEY!, fetch: observedFetch }, modelId);
    const tools = { read_marker: tool({ name: "read_marker", description: "Read the verification marker.", schema: z.object({}), execute: async () => "REPLAY_OK_913" }) };
    const messages: ModelMessage[] = [{ role: "user", parts: [{ type: "text", text: "Call read_marker once, then reply with its returned marker only." }] }];
    const invoke = async (): Promise<ModelMessage> => {
      const model = makeModel(); // New instance, no process-local provider history.
      const input = { messages: JSON.parse(JSON.stringify(messages)) as ModelMessage[], tools, maxRetries: 0, maxTokens: 2048, abortSignal: AbortSignal.timeout(90_000) };
      if (mode === "generate") return (await model.generate(input)).messages![0]!;
      const message: ModelMessage = { role: "assistant", parts: [] };
      for await (const event of await model.stream!(input)) {
        if (event.type === "text-delta") message.parts.push({ type: "text", text: event.textDelta });
        if (event.type === "tool-call") message.parts.push({ type: "tool-call", toolCall: event.toolCall });
        if (event.type === "provider-data") message.parts.push({ type: "provider-data", provider: event.provider, data: event.data });
      }
      return message;
    };
    const first = await invoke();
    const calls = first.parts.filter(part => part.type === "tool-call");
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.toolCall.name, "read_marker");
    messages.push(first, { role: "tool", parts: [{ type: "tool-result", toolResult: {
      toolCallId: call.toolCall.id, toolName: "read_marker", output: "REPLAY_OK_913", isError: false
    } }] });
    const final = await invoke();
    assert.equal(final.parts.filter(part => part.type === "text").map(part => part.text).join("").trim(), "REPLAY_OK_913");
    rows.push({ mode, status: "passed", requests, encryptedReplay });
  }
  console.log(JSON.stringify({ provider: "meta", model: modelId, rows }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ provider: "meta", model: modelId, rows, error: sanitizeOperationalError(error) }, null, 2));
  process.exitCode = 1;
}
