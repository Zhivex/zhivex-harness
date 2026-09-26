import { createHash } from "node:crypto";
import { z } from "zod";
import { wrapLanguageModel, type LanguageModel, type ModelGenerateInput, type ModelMessage, type ToolCall } from "@zhivex-ai/core";
import { HarnessConfigError } from "./errors.js";

/** Trusted application input, never constructed from a model tool call. */
export interface HarnessDelegationContract {
  taskId: string;
  profile: "reviewer" | "explorer";
  prompt: string;
  allowedReadPaths: readonly string[];
  requiredOutput: string;
}

const relativeFile = z.string().min(1).max(1024).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
  !value.includes(":") && value.split("/").every(part => part !== ".." && part !== "." && part !== ""));
const schema = z.array(z.strictObject({
  taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  profile: z.enum(["reviewer", "explorer"]),
  prompt: z.string().min(1).max(16000),
  allowedReadPaths: z.array(relativeFile).min(1).max(32),
  requiredOutput: z.string().min(1).max(256)
})).min(1).max(2);

export const normalizeDelegationContracts = (value?: readonly HarnessDelegationContract[]) => {
  if (value === undefined) return [];
  const parsed = schema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.map(c => c.profile)).size !== parsed.data.length ||
      new Set(parsed.data.map(c => c.taskId)).size !== parsed.data.length) {
    throw new HarnessConfigError("Delegation contracts require unique tasks/profiles and canonical relative file paths.");
  }
  return parsed.data.map(c => Object.freeze({ ...c, allowedReadPaths: Object.freeze([...new Set(c.allowedReadPaths)].sort()) }));
};

export const delegationPrompt = (contract: HarnessDelegationContract) =>
  `Application-owned task ${contract.taskId}:\n${contract.prompt}\nAllowed read paths: ${JSON.stringify(contract.allowedReadPaths)}.\nInclude this exact completion marker on its own line in the final response, without a label or prefix: ${contract.requiredOutput}`;

export const delegationFingerprint = (contracts: readonly HarnessDelegationContract[]) =>
  createHash("sha256").update(JSON.stringify({ policy: "completion-marker-v4-recoverable-input", contracts })).digest("hex");

/** Adapt the public task-ID contract to the SDK's durable subagent protocol.
 * Only validated IDs resolve to trusted prompts. SDK still owns approvals,
 * execution, child linkage, cancellation and accounting.
 */
export const withDelegationContracts = (model: LanguageModel, contracts: readonly HarnessDelegationContract[]): LanguageModel => {
  if (!contracts.length) return model;
  const byTool = new Map(contracts.map(c => [`delegate_${c.profile}`, c]));
  const prepare = (input: ModelGenerateInput) => {
    const registered = new Set(Object.keys(input.tools ?? {}));
    input.tools = Object.fromEntries([...byTool].flatMap(([name, contract]) => {
      const original = input.tools?.[name];
      // Rejected public calls use null to reach the SDK's normal validation
      // recovery. Never rely on this sentinel if an execution schema accepts it.
      if (original && (!("schema" in original) || original.schema.safeParse(null).success)) {
        throw new HarnessConfigError("Delegation requires an object input execution schema.");
      }
      return original ? [[name, { ...original,
        description: `Execute application-owned task ${contract.taskId}. Its scope and acceptance are fixed. Supply only taskId.`,
        schema: z.strictObject({ taskId: z.literal(contract.taskId) })
      }]] : [];
    }));
    const calls = new Map<string, string>();
    // Only exact trusted prompts have a public task-ID representation. Failed
    // calls must not appear in history as if the model selected a valid task.
    input.messages = input.messages.map(message => ({ ...message, parts: message.parts.map(part => {
      if (message.role === "assistant" && part.type === "tool-call") {
        calls.set(part.toolCall.id, part.toolCall.name);
        const contract = byTool.get(part.toolCall.name);
        return contract && z.strictObject({ prompt: z.literal(delegationPrompt(contract)) }).safeParse(part.toolCall.input).success
          ? { ...part, toolCall: { ...part.toolCall, input: { taskId: contract.taskId } } } : part;
      }
      if (message.role !== "tool" || part.type !== "tool-result") return part;
      const result = part.toolResult;
      if (calls.get(result.toolCallId) !== result.toolName) return part;
      calls.delete(result.toolCallId);
      if (!result.isError || !result.error) return part;
      const contract = byTool.get(result.toolName);
      const guidance = result.error.code === "TOOL_INPUT_VALIDATION_ERROR" && contract
        ? `Delegation was not executed. Retry ${result.toolName} with exactly ${JSON.stringify({ taskId: contract.taskId })}. Supply only taskId; do not send prompt, system, or other fields.`
        : result.error.code === "TOOL_NOT_REGISTERED"
          ? `Use only these application-owned delegations: ${[...byTool].map(([name, item]) => `${name} ${JSON.stringify({ taskId: item.taskId })}`).join("; ")}.` : undefined;
      return guidance ? { ...part, toolResult: { ...result, error: { ...result.error, message: `${result.error.message} ${guidance}` } } } : part;
    }) }));
    return (call: ToolCall): ToolCall => {
      const contract = byTool.get(call.name);
      if (!contract) {
        // Unknown names enter the SDK's bounded unknown-tool recovery. A real
        // but hidden tool must never acquire execution authority this way.
        if (registered.has(call.name)) throw Object.assign(new HarnessConfigError("DELEGATION_CONTRACT_VIOLATION"), { delegation: "contract" });
        return call;
      }
      if (!z.strictObject({ taskId: z.literal(contract.taskId) }).safeParse(call.input).success) {
        // SDK delegate inputs are objects with a required prompt string. Null
        // is deliberately non-executable, including when untrusted input had
        // an otherwise valid prompt/system pair. SDK owns failure and budgets.
        return { ...call, input: null };
      }
      return { ...call, input: { prompt: delegationPrompt(contract) } };
    };
  };
  const resolveMessage = (message: ModelMessage, resolve: (call: ToolCall) => ToolCall): ModelMessage => ({
    ...message, parts: message.parts.map(part => part.type === "tool-call"
      ? { ...part, toolCall: resolve(part.toolCall) } : part)
  });
  return wrapLanguageModel(model, [{
    name: "harness-delegation-contract-v2",
    async wrapGenerate({ input }, next) {
      const resolve = prepare(input);
      const result = await next();
      return { ...result,
        ...(result.message ? { message: resolveMessage(result.message, resolve) } : {}),
        ...(result.messages ? { messages: result.messages.map(message => resolveMessage(message, resolve)) } : {})
      };
    },
    async wrapStream({ input }, next) {
      const resolve = prepare(input);
      const events = await next();
      return (async function* () {
        for await (const event of events) yield event.type === "tool-call"
          ? { ...event, toolCall: resolve(event.toolCall) } : event;
      })();
    }
  }]);
};
