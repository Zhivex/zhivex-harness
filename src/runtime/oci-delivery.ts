import { randomUUID } from "node:crypto";
import type { LanguageModelMiddleware, ModelMessage, StreamEvent, ToolCall } from "@zhivex-ai/core";
import type { AgentRunStore } from "@zhivex-ai/agents/ops";

export const OCI_DELIVERY_KEY = "zhivexOciDelivery";
const imports = new Set(["apply_environment_patch", "verify_and_apply_environment_patch", "verify_and_apply_reviewed_edits"]);
const reminderText = "OCI delivery pending: changes still exist only in the isolated workspace. Inspect the patch, complete the relevant verification, and request the ordinary approved import. Do not claim delivery before import. Never bypass a rejected approval.";

/** Completion follows actual filesystem delivery, independently of verified-delivery policy.
 * Only a read-only inspection is scheduled; import retains the ordinary approval gates. */
export const createOciDelivery = (pending: () => Promise<boolean>, metadata: Record<string, unknown>, reset = false) => {
  const saved = metadata[OCI_DELIVERY_KEY] as { reminders?: unknown; declined?: unknown } | undefined;
  let reminders = !reset && Number.isSafeInteger(saved?.reminders) ? Math.max(0, Math.min(2, saved!.reminders as number)) : 0;
  let declined = !reset && saved?.declined === true;
  const resolved = (tool: string, approved: boolean) => { if (imports.has(tool) && !approved) declined = true; };
  const remind = async (reason: unknown, sawTool: boolean, available: boolean, signal?: AbortSignal): Promise<ToolCall | undefined> => {
    signal?.throwIfAborted();
    if (reason !== "stop" || sawTool || !available || declined || reminders >= 2) return;
    try { if (!await pending()) return; } catch { return; }
    signal?.throwIfAborted();
    reminders++;
    return { id: `oci_delivery_${randomUUID()}`, name: "inspect_environment_patch", input: {} };
  };
  const middleware: LanguageModelMiddleware = {
    name: "harness-oci-delivery",
    async wrapGenerate(context, next) {
      if (reminders && !declined) context.input.messages = [...context.input.messages, { role: "system", parts: [{ type: "text", text: reminderText }] }];
      const result = await next();
      const messages = result.messages ?? (result.message ? [result.message] : []);
      const call = await remind(result.finishReason, messages.some(m => m.parts.some(p => p.type === "tool-call" || p.type === "tool-result")), Boolean(context.input.tools?.inspect_environment_patch), context.input.abortSignal);
      if (!call) return result;
      const last = messages.at(-1);
      const message: ModelMessage = { role: "assistant", parts: [...(last?.role === "assistant" ? last.parts : []), { type: "tool-call", toolCall: call }] };
      return { ...result, message, messages: [...(last?.role === "assistant" ? messages.slice(0, -1) : messages), message], finishReason: "tool-calls", providerFinishReason: "harness-oci-delivery" };
    },
    async wrapStream(context, next) {
      if (reminders && !declined) context.input.messages = [...context.input.messages, { role: "system", parts: [{ type: "text", text: reminderText }] }];
      const stream = await next();
      return (async function* (): AsyncIterable<StreamEvent> {
        let sawTool = false;
        let finish: Extract<StreamEvent, { type: "finish" }> | undefined;
        for await (const event of stream) {
          if (["tool-call", "tool-result", "tool-approval-request", "error"].includes(event.type)) sawTool = true;
          if (event.type === "finish") {
            if (finish) throw new Error("OCI_DELIVERY_AMBIGUOUS_STREAM");
            finish = event;
          } else yield event;
        }
        if (!finish) return;
        const call = await remind(finish.finishReason, sawTool, Boolean(context.input.tools?.inspect_environment_patch), context.input.abortSignal);
        if (call) yield { type: "tool-call", toolCall: call };
        yield call ? { ...finish, finishReason: "tool-calls", providerFinishReason: "harness-oci-delivery" } : finish;
      })();
    }
  };
  const store = (base: AgentRunStore, runId: string): AgentRunStore => new Proxy(base, {
    get(target, key) {
      if (key === "save") return async (...args: Parameters<AgentRunStore["save"]>) => {
        const [state] = args;
        if (state.runId === runId) {
          state.metadata = { ...state.metadata, [OCI_DELIVERY_KEY]: { reminders, declined } };
          if (state.status === "completed") {
            let incomplete: boolean;
            let inspectionFailed = false;
            try { incomplete = await pending(); }
            catch { incomplete = true; inspectionFailed = true; }
            if (incomplete) {
              state.status = "failed";
              state.outputText = "Changes remain in the isolated workspace; delivery to the repository is incomplete.";
              state.error = { message: inspectionFailed ? "OCI_DELIVERY_INSPECTION_FAILED" : declined ? "OCI_DELIVERY_DECLINED" : "OCI_DELIVERY_PENDING" };
              delete state.finalOutput;
            }
          }
        }
        return target.save(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { middleware, store, resolved };
};
