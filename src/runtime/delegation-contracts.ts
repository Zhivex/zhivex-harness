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
  `Application-owned task ${contract.taskId}:\n${contract.prompt}\nAllowed read paths: ${JSON.stringify(contract.allowedReadPaths)}.\nInclude this exact acceptance token in the final response: ${contract.requiredOutput}`;

export const delegationFingerprint = (contracts: readonly HarnessDelegationContract[]) =>
  createHash("sha256").update(JSON.stringify(contracts)).digest("hex");

/** Adapt the public task-ID contract to the SDK's durable subagent protocol.
 * Only validated IDs resolve to trusted prompts. SDK still owns approvals,
 * execution, child linkage, cancellation and accounting.
 */
export const withDelegationContracts = (model: LanguageModel, contracts: readonly HarnessDelegationContract[]): LanguageModel => {
  if (!contracts.length) return model;
  const byTool = new Map(contracts.map(c => [`delegate_${c.profile}`, c]));
  const prepare = (input: ModelGenerateInput) => {
    input.tools = Object.fromEntries([...byTool].flatMap(([name, contract]) => {
      const original = input.tools?.[name];
      return original ? [[name, { ...original,
        description: `Execute application-owned task ${contract.taskId}. Its scope and acceptance are fixed. Supply only taskId.`,
        schema: z.strictObject({ taskId: z.literal(contract.taskId) })
      }]] : [];
    }));
    // History uses the SDK's canonical input; expose only the public contract.
    input.messages = input.messages.map(message => ({ ...message, parts: message.parts.map(part => {
      if (part.type !== "tool-call") return part;
      const contract = byTool.get(part.toolCall.name);
      return contract ? { ...part, toolCall: { ...part.toolCall, input: { taskId: contract.taskId } } } : part;
    }) }));
  };
  const resolve = (call: ToolCall): ToolCall => {
    const contract = byTool.get(call.name);
    if (!contract || !z.strictObject({ taskId: z.literal(contract.taskId) }).safeParse(call.input).success) {
      throw Object.assign(new HarnessConfigError("DELEGATION_CONTRACT_VIOLATION"), { delegation: "contract" });
    }
    return { ...call, input: { prompt: delegationPrompt(contract) } };
  };
  const resolveMessage = (message: ModelMessage): ModelMessage => ({
    ...message, parts: message.parts.map(part => part.type === "tool-call"
      ? { ...part, toolCall: resolve(part.toolCall) } : part)
  });
  return wrapLanguageModel(model, [{
    name: "harness-delegation-contract-v1",
    async wrapGenerate({ input }, next) {
      prepare(input);
      const result = await next();
      return { ...result,
        ...(result.message ? { message: resolveMessage(result.message) } : {}),
        ...(result.messages ? { messages: result.messages.map(resolveMessage) } : {})
      };
    },
    async wrapStream({ input }, next) {
      prepare(input);
      const events = await next();
      return (async function* () {
        for await (const event of events) yield event.type === "tool-call"
          ? { ...event, toolCall: resolve(event.toolCall) } : event;
      })();
    }
  }]);
};
