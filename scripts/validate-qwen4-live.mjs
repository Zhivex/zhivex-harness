import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { tool } from "@zhivex-ai/core";
import { z } from "zod";

if (process.env.ZHIVEX_HARNESS_LIVE !== "1") throw new Error("Set ZHIVEX_HARNESS_LIVE=1 to authorize paid provider calls.");
const report = { model: "qwen4-max", checkedAt: new Date().toISOString(), scope: "Installed CLI and Electron provider runtimes; not UI automation", cases: [] };
for (const client of ["cli", "desktop"]) {
  const installed = new URL(`../packages/${client}/node_modules/@zhivex-ai/harness/`, import.meta.url);
  const metadata = JSON.parse(await readFile(new URL("package.json", installed), "utf8"));
  const { createProviderModel } = await import(new URL(metadata.exports["./engine"].import, installed).href);
  for (const apiMode of ["chat", "responses"]) for (const streaming of [false, true]) {
    const record = { client, apiMode, streaming, ok: false };
    report.cases.push(record);
    const started = Date.now();
    try {
      const model = createProviderModel({ provider: "qwen", model: report.model }, process.env);
      // The unpredictable receipt is exposed only by the local tool result.
      const receipt = `QWEN4_${randomUUID().replaceAll("-", "")}`;
      let executions = 0;
      const schema = z.object({ label: z.literal("live-check") });
      const execute = () => { executions++; return receipt; };
      const tools = { read_receipt: tool({ name: "read_receipt", description: "Read the validation receipt.", schema, execute }) };
      const messages = [{ role: "user", parts: [{ type: "text", text: 'Call read_receipt with label "live-check" once. Then reply with exactly the receipt returned by that tool, without formatting or additional words.' }] }];
      const options = { tools, maxTokens: 2048, reasoning: { effort: "low" }, providerOptions: { apiMode }, abortSignal: AbortSignal.timeout(60000) };
      let calls = [], text = "", deltas = 0, reasoningParts = 0;
      const usages = [];
      async function turn() {
        if (!streaming) {
          const result = await model.generate({ ...options, messages });
          assert.ok(result.messages?.length, "Missing assistant history");
          messages.push(...result.messages);
          calls = result.messages.flatMap(m => m.parts).filter(p => p.type === "tool-call").map(p => p.toolCall);
          text = result.text ?? "";
          if (result.usage) usages.push(result.usage);
          reasoningParts += result.messages.flatMap(m => m.parts).filter(p => p.type === "provider-data").length;
          return;
        }
        const parts = [];
        calls = []; text = "";
        for await (const event of await model.stream({ ...options, messages })) {
          if (event.type === "tool-call") { calls.push(event.toolCall); parts.push({ type: "tool-call", toolCall: event.toolCall }); }
          if (event.type === "provider-data") { parts.push(event); reasoningParts++; }
          if (event.type === "text-delta") { text += event.textDelta; deltas++; }
          if (event.type === "finish" && event.usage) usages.push(event.usage);
        }
        if (text) parts.push({ type: "text", text });
        messages.push({ role: "assistant", parts });
      }
      await turn();
      assert.equal(calls.length, 1, "Expected one tool call");
      const call = calls[0];
      assert.equal(call.name, "read_receipt");
      schema.parse(call.input);
      const output = execute();
      messages.push({ role: "tool", parts: [{ type: "tool-result", toolResult: { toolCallId: call.id, toolName: call.name, output, isError: false } }] });
      await turn();
      assert.equal(calls.length, 0, "Unexpected additional tool call");
      assert.equal(text.trim(), receipt, "Final answer must match the actual tool result");
      assert.equal(executions, 1);
      if (streaming) assert.ok(deltas > 0, "No streamed text received");
      Object.assign(record, { ok: true, toolExecutions: executions, textDeltas: deltas, reasoningParts, usages });
    } catch (error) {
      // Never serialize request headers, provider bodies or credential-bearing errors.
      Object.assign(record, { errorType: error?.constructor?.name, status: error?.status ?? error?.statusCode, ...(error?.code === "ERR_ASSERTION" ? { assertion: error.message } : {}) });
      process.exitCode = 1;
    }
    record.durationMs = Date.now() - started;
    console.log(JSON.stringify(record));
  }
}
await writeFile(new URL("../docs/reports/evidence/qwen4-max-live-2026-11-16.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
