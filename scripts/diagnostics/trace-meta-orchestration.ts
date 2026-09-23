/** Bounded live attribution probe. Raw transport exists in memory only. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMeta } from "@zhivex-ai/meta";
import { wrapLanguageModel } from "@zhivex-ai/core";
import { createHarness, runHarness } from "../../src/runtime/harness.js";
import { prepareReviewFixture, orchestrationPrompt, reviewDelegationContract } from "../live-orchestration-smoke.js";
import { sanitizeOperationalError } from "../release-diagnostics.js";

const parentMarker = "ZHIVEX_HARNESS_META_ORCHESTRATION_OK";
const childMarker = "ZHIVEX_HARNESS_META_CHILD_OK";
const flags = (text: string) => ({ characters: text.length, parentMarker: text.includes(parentMarker), childMarker: text.includes(childMarker) });
const main = async () => {
  if (process.env.ZHIVEX_HARNESS_LIVE !== "1") throw new Error("Explicit live opt-in required");
  const mode = process.argv[2] ?? "chat";
  if (!["chat", "responses"].includes(mode)) throw new Error("Unsupported mode");
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("Missing credentials");
  const records: Record<string, unknown>[] = [];
  const pending: Promise<void>[] = [];
  const normalizedTexts: string[] = [];
  const wireTexts: string[] = [];
  const makeModel = (role: "parent" | "child") => {
    const fetcher: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const index = records.length;
      const record: Record<string, unknown> = { role, streaming: body.stream === true, responses: Array.isArray(body.input), requestHasParentInstruction: JSON.stringify(body).includes(parentMarker), requestHasChildReceipt: (body.messages ?? body.input ?? []).some((message: {role?: string; type?: string}) => (message.role === "tool" || message.type === "function_call_output") && JSON.stringify(message).includes(childMarker)) };
      records.push(record);
      const response = await fetch(url, init);
      record.httpStatus = response.status;
      pending.push(response.clone().text().then(raw => {
        let text = ""; let reasoning = ""; let finish: unknown;
        let calls = 0;
        if (body.stream) {
          for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
            const data = JSON.parse(line.slice(5));
            const choice = data.choices?.[0];
            text += choice?.delta?.content ?? (data.type === "response.output_text.delta" ? data.delta : "");
            reasoning += choice?.delta?.reasoning_content ?? "";
            if (choice?.finish_reason) finish = choice.finish_reason;
            if (data.type === "response.completed") finish = data.response?.status;
            if (data.type === "response.output_item.done" && data.item?.type === "function_call") calls++;
            calls += choice?.delta?.tool_calls?.filter((c: {function?: {name?: string}}) => c.function?.name)?.length ?? 0;
          }
        } else {
          const data = JSON.parse(raw);
          text = data.choices?.[0]?.message?.content ?? (data.output ?? []).flatMap((item: {content?: {type: string; text?: string}[]}) => item.content ?? []).filter((p: {type: string}) => p.type === "output_text").map((p: {text?: string}) => p.text ?? "").join("");
          reasoning = data.choices?.[0]?.message?.reasoning_content ?? "";
          finish = data.choices?.[0]?.finish_reason ?? data.status;
          calls = data.choices?.[0]?.message?.tool_calls?.length ?? (data.output ?? []).filter((item: {type?: string}) => item.type === "function_call").length;
        }
        wireTexts[index] = text;
        record.wireText = flags(text); if (mode === "chat") record.reasoning = flags(reasoning); record.toolCalls = calls;
        record.finish = ["stop", "length", "tool_calls", "completed", "incomplete"].includes(String(finish)) ? finish : "other";
      }).catch(() => { record.captureFailed = true; }));
      return response;
    }, { preconnect: fetch.preconnect });
    return wrapLanguageModel(createMeta({apiKey, fetch: fetcher, ...(process.env.META_BASE_URL ? {baseURL: process.env.META_BASE_URL} : {})})("muse-spark-1.3"), [{
      name: "diagnostic-normalized-projection",
      async wrapGenerate({input}, next) {
        if (mode === "responses") input.providerOptions = {...input.providerOptions, apiMode: "responses"};
        const index = records.length;
        const result = await next();
        normalizedTexts[index] = result.text ?? "";
        return result;
      },
      async wrapStream({input}, next) {
        if (mode === "responses") input.providerOptions = {...input.providerOptions, apiMode: "responses"};
        const index = records.length;
        const stream = await next();
        return (async function* () {
          let text = "";
          for await (const event of stream) {
            if (event.type === "text-delta") text += event.textDelta;
            yield event;
          }
          normalizedTexts[index] = text;
        })();
      }
    }]);
  };
  const workspace = await mkdtemp(path.join(os.tmpdir(), "zhx-meta-attribution-"));
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  let resultEvidence: Record<string, unknown> = {};
  try {
    await prepareReviewFixture(workspace);
    harness = await createHarness({provider:"meta", model:"muse-spark-1.3", workspace, stateDirectory:path.join(workspace,"state"), modelInstance:makeModel("parent"), subagentModels:{reviewer:makeModel("child")}, maxSteps:4, maxToolCalls:4, subagentProfiles:["reviewer"], delegationContracts:[reviewDelegationContract("meta")], subagentMaxSteps:2, subagentMaxToolCalls:1, env:process.env});
    const result = await runHarness(harness, {prompt:orchestrationPrompt("meta"), maxSteps:4, toolChoice:"auto", scope:harness.config.scope});
    const lastParentIndex = records.findLastIndex(r => r.role === "parent");
    resultEvidence = {completed:result.status === "completed", output:flags(result.outputText), outputEqualsLastNormalized:result.outputText === normalizedTexts[lastParentIndex], outputEqualsAllParentText:result.outputText === normalizedTexts.filter((_,index)=>records[index]?.role === "parent").join(""), childCount:result.state.childRuns?.length ?? 0, children:result.state.childRuns?.map(c=>({completed:c.status === "completed", output:flags(c.outputText), toolCalls:c.toolCalls, toolErrors:c.toolErrors})), ...(result.error ? {error:sanitizeOperationalError(result.error)} : {})};
  } catch(error) { resultEvidence = {error:sanitizeOperationalError(error)}; }
  finally { await harness?.close(); await Promise.all(pending); await rm(workspace,{recursive:true,force:true}); }
  records.forEach((r,i)=>{r.normalizedText=flags(normalizedTexts[i] ?? "");r.wireEqualsNormalized=wireTexts[i] !== undefined && normalizedTexts[i] !== undefined && wireTexts[i] === normalizedTexts[i];});
  process.stdout.write(JSON.stringify({mode, model:"muse-spark-1.3", records, result:resultEvidence},null,2)+"\n");
};
if (import.meta.main) main().catch(error=>{process.stderr.write(JSON.stringify({error:sanitizeOperationalError(error)})+"\n");process.exitCode=1;});
