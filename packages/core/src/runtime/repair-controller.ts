import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { GenerateResult, LanguageModelMiddleware, ModelGenerateInput, ModelMessage, StreamEvent, TokenUsage, ToolCall, ToolSet } from "@zhivex-ai/core";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import { harnessExecutionSession } from "../execution/execution-environment.js";
import { taskSources } from "../context/task-memory.js";
import type { createRepairProgress } from "./repair-progress.js";

export const REPAIR_CONTROLLER_KEY = "zhivexRepairController";
import { verifierSchema } from "./repair-verifier.js";
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const stateSchema = z.object({ schemaVersion: z.literal(1),
  phase: z.enum(["explore", "reproduce", "candidate", "verify", "recover", "delivered", "incomplete"]),
  candidate: digestSchema.nullable(), revision: z.number().int().nonnegative(),
  verifier: verifierSchema.nullable(), verifierRequests: z.number().int().nonnegative(),
  verificationFailures: z.number().int().nonnegative(),
  completionReminders: z.number().int().min(0).max(1).default(0),
  planRequired: z.boolean().default(false),
  workBudgetClosure: z.boolean().default(false),
  requireVerifiedDelivery: z.boolean().default(false),
  hypothesis: z.string().max(1000), nextCheck: z.string().max(500),
  receipts: z.array(z.object({ commandId: z.string().max(128), purpose: z.string().max(500),
    argvDigest: digestSchema, candidate: digestSchema.nullable(), exitCode: z.number().int(),
    verified: z.boolean() })).max(8) });
const mutations = new Set(["apply_reviewed_edits", "apply_reviewed_replacement", "apply_patch", "move_file", "quarantine_file", "restore_file"]);
const commands = new Set(["run_environment_command", "run_environment_shell", "run_environment_batch"]);
const terminal = new Set(["verify_and_apply_environment_patch", "verify_and_apply_reviewed_edits"]);
const redact = createRedactionPolicy({ includeEmails: true });
const sha = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Application-owned evidence controller. Scheduling is not approval. All emitted
 * calls enter the ordinary SDK registry, approval, lease and execution gates. */
export const createRepairController = (metadata: Record<string, unknown>, oci: boolean,
  options: { requireVerifiedDelivery?: boolean; progressContext?: ReturnType<typeof createRepairProgress>["workingContext"];
    workBudgetReached?: (input: ModelGenerateInput) => boolean } = {}) => {
  const state = metadata[REPAIR_CONTROLLER_KEY] === undefined ? stateSchema.parse({ schemaVersion: 1,
    phase: "explore", candidate: null, revision: 0, verifier: null, verifierRequests: 0,
    verificationFailures: 0, hypothesis: "", nextCheck: "", receipts: [] }) : stateSchema.parse(metadata[REPAIR_CONTROLLER_KEY]);
  state.requireVerifiedDelivery ||= options.requireVerifiedDelivery === true;
  const snapshot = () => structuredClone(state);
  const pending = () => state.candidate !== null && state.phase !== "delivered";
  // A rejected edit creates a bounded planning obligation too. Its next model
  // turns expose only plan/task tools and retain the two-attempt durable limit;
  // permit those turns to use the existing reserve, never extra total tokens.
  const closure = () => state.workBudgetClosure || state.planRequired || pending() || state.phase === "recover";
  const completionPending = () => (state.requireVerifiedDelivery && state.phase !== "delivered") || state.planRequired || pending() || (state.verifier !== null && state.phase !== "delivered");
  const markIncomplete = () => { if (completionPending()) state.phase = "incomplete"; };
  const verificationFailed = (attemptedVerification = true) => { if (attemptedVerification) state.verificationFailures++; state.phase = "recover"; state.verifier = null; state.verifierRequests = 0; };
  const wrapTools = (tools: ToolSet): ToolSet => Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!("execute" in tool)) return [name, tool];
    return [name, { ...tool, async execute(input, context) {
      let executed = false;
      try {
        // Make the documented plan-before-edit contract executable. A concrete
        // verifier is still model-authored and requires its own approval later.
        if (oci && mutations.has(name) && !state.verifier) state.planRequired = true;
        if (state.planRequired && !state.verifier && !["repair_plan", "read_task", "environment_status", "mutation_audit"].includes(name)) {
          throw new Error("REPAIR_PLAN_REQUIRED: call repair_plan with exact verifier command, args and purpose before editing. No edit was executed. The verifier must assert the requested behavior; recording it is not approval.");
        }
        // Narrowing the transport catalogue alone is not an execution policy.
        if (pending() && state.phase !== "recover" && !terminal.has(name) &&
          !["repair_plan", "read_task", "inspect_environment_patch", "environment_status", "mutation_audit", "run_check"].includes(name)) {
          throw new Error("REPAIR_VERIFICATION_REQUIRED: verify the existing candidate before further exploration; revise the plan after a failed check.");
        }
        executed = true;
        const value = await tool.execute(input, context);
        const output = record(value);
        if (name === "repair_plan") {
          const plan = record(input);
          state.hypothesis = redact.redactText(String(plan.hypothesis ?? "")).slice(0, 1000);
          state.nextCheck = redact.redactText(String(plan.nextCheck ?? "")).slice(0, 500);
          if (plan.verifier !== undefined) {
            state.verifier = verifierSchema.parse(plan.verifier);
            if (state.planRequired) { state.planRequired = false; state.verifierRequests = 0; }
            if (pending()) state.phase = "candidate";
          }
        }
        if (mutations.has(name) || commands.has(name)) {
          const session = harnessExecutionSession(context);
          const patch = session ? await session.inspectPatch() : undefined;
          const candidate = patch ? (patch.entries.length ? patch.patchId : null) : mutations.has(name) ? sha(output) : state.candidate;
          if (candidate !== state.candidate) { state.revision++; state.verifierRequests = 0; }
          state.candidate = candidate;
          state.phase = candidate ? "candidate" : commands.has(name) ? "reproduce" : "explore";
        }
        if (name === "inspect_environment_patch" && Array.isArray(output.entries)) {
          const candidate = output.entries.length ? digestSchema.parse(output.patchId) : null;
          if (candidate !== state.candidate) { state.revision++; state.verifierRequests = 0; }
          state.candidate = candidate;
          if (state.phase !== "recover") state.phase = candidate ? "candidate" : "explore";
        }
        if (terminal.has(name) && typeof output.patchId === "string") {
          const candidate = digestSchema.parse(output.patchId);
          if (candidate !== state.candidate) state.revision++;
          state.candidate = candidate;
        }
        const verification = terminal.has(name) ? record(output.verification) : output;
        if ((commands.has(name) || terminal.has(name) || name === "run_check") && Number.isSafeInteger(verification.exitCode)) {
          const passed = verification.exitCode === 0 && verification.timedOut !== true;
          state.receipts.push({ commandId: context?.toolCall?.id ?? `check_${randomUUID()}`,
            purpose: redact.redactText((state.verifier?.purpose ?? state.nextCheck) || "Command execution; requirement coverage not established").slice(0, 500),
            argvDigest: sha(input), candidate: state.candidate, exitCode: verification.exitCode as number,
            verified: passed && (terminal.has(name) || (!oci && name === "run_check" && pending())) });
          if (state.receipts.length > 8) state.receipts.shift();
          if (passed && (terminal.has(name) || (!oci && name === "run_check" && pending()))) state.phase = "delivered";
          else if (!passed && pending()) verificationFailed(terminal.has(name) || (!oci && name === "run_check"));
        }
        return value;
      } catch (error) {
        // Effects can occur before a command/mutation throws. Reinspect the
        // actual snapshot; never let a failed result hide an unverified edit.
        if (executed && (mutations.has(name) || commands.has(name) || terminal.has(name))) {
          try {
            const session = harnessExecutionSession(context);
            const patch = session ? await session.inspectPatch() : undefined;
            const candidate = patch ? (patch.entries.length ? patch.patchId : null) : sha({ failedTool: name, call: context?.toolCall?.id });
            const changed = candidate !== state.candidate;
            if (changed) state.revision++;
            state.candidate = candidate;
            // A failed tool can change files after an earlier verified delivery.
            // Do not let the old delivered phase hide a new, unverified revision.
            if (candidate !== null && (changed || pending())) {
              const failure = record(record(error).verification);
              if (Number.isSafeInteger(failure.exitCode)) {
                state.receipts.push({ commandId: context?.toolCall?.id ?? `check_${randomUUID()}`,
                  purpose: redact.redactText(state.verifier?.purpose ?? state.nextCheck).slice(0, 500),
                  argvDigest: sha(input), candidate, exitCode: failure.exitCode as number, verified: false });
                if (state.receipts.length > 8) state.receipts.shift();
              }
              verificationFailed(terminal.has(name));
            }
          } catch {
            state.candidate ??= sha({ uninspectedEffect: name, call: context?.toolCall?.id });
            state.phase = "incomplete";
          }
        }
        throw error;
      } finally { if (context?.metadata) context.metadata[REPAIR_CONTROLLER_KEY] = snapshot(); }
    } }];
  }));
  const prepare = (input: ModelGenerateInput, provider: string): ToolCall | undefined => {
    input.abortSignal?.throwIfAborted();
    const sources = taskSources(metadata);
    const latest = sources.at(-1);
    const projection = { activeRequest: latest ? { id: latest.id, excerpt: latest.text.slice(0, 1600), totalCharacters: latest.text.length } : null,
      previousRequestIds: sources.slice(-4, -1).map(source => source.id),
      phase: state.phase, candidate: state.candidate, revision: state.revision, planRequired: state.planRequired,
      requireVerifiedDelivery: state.requireVerifiedDelivery,
      workBudgetClosure: state.workBudgetClosure,
      hypothesis: state.hypothesis, nextCheck: state.nextCheck, checks: state.receipts.slice(-2),
      progress: options.progressContext?.() ?? null,
      completionReminder: state.completionReminders > 0 ? "A final answer did not fulfill the repair. Continue the focused repair and verification; do not claim delivery without a verified candidate." : null };
    const workingState = { type: "text" as const, text: "" };
    const renderState = () => { workingState.text = `[Harness working state; not approval]\n${JSON.stringify(projection)}\nUse read_task for complete constraints if the excerpt is incomplete. A candidate must be verified before completion.`; };
    renderState();
    input.messages = [...input.messages, { role: "user", parts: [workingState] }];
    // Inspect this request, including the working-state message, before the
    // budget gate rejects exploration. Reuse the durable two-attempt planning
    // path; selecting a plan neither authorizes edits nor increases ceilings.
    if (oci && state.requireVerifiedDelivery && !pending() &&
      ["explore", "reproduce"].includes(state.phase) && options.workBudgetReached?.(input)) {
      // Keep the existing reserve available after the plan is recorded and
      // across checkpoints, so the committed repair can reach its first edit.
      state.workBudgetClosure = true;
      projection.workBudgetClosure = true;
      if (!state.verifier) state.planRequired = true;
      projection.planRequired = state.planRequired;
      renderState();
    }
    if (state.phase === "incomplete") throw new Error("REPAIR_INCOMPLETE: authorization or verification is missing.");
    if (pending() && state.verificationFailures > 2) throw new Error("REPAIR_VERIFICATION_RETRIES_EXHAUSTED");
    if (state.planRequired && !state.verifier) {
      if (state.verifierRequests >= 2) throw new Error("REPAIR_PLAN_MISSING: register a concrete verifier before editing.");
      if (!input.tools?.repair_plan) throw new Error("REPAIR_VERIFIER_UNAVAILABLE");
      state.verifierRequests++;
      input.tools = Object.fromEntries(Object.entries(input.tools).filter(([name]) => ["repair_plan", "read_task"].includes(name)));
      const supported = provider !== "qwen" || input.reasoning?.effort === "none" || input.providerOptions?.enable_thinking === false;
      input.toolChoice = supported ? { type: "tool", toolName: "repair_plan" } : "auto";
      return;
    }
    if (!pending()) {
      // A concrete repair plan is a commitment, even before the first edit.
      // Request progress rather than accepting a premature final answer. The
      // checkpoint gate still rejects completion if the provider ignores this.
      if (completionPending()) {
        const supported = provider !== "qwen" || input.reasoning?.effort === "none" || input.providerOptions?.enable_thinking === false;
        input.toolChoice = supported ? "required" : "auto";
      }
      return;
    }
    if (oci && state.verifier && state.phase !== "recover" && input.tools?.verify_and_apply_environment_patch) {
      state.phase = "verify";
      return { id: `controller_${randomUUID()}`, name: "verify_and_apply_environment_patch",
        input: { patchId: state.candidate, command: state.verifier.command, args: state.verifier.args } };
    }
    if (state.phase === "recover") {
      // A final answer cannot discharge an outstanding verification obligation.
      // Ask for a diagnostic/repair action while ordinary tool and token limits
      // still bound recovery. Providers with thinking restrictions retain auto.
      const requiredChoiceSupported = provider !== "qwen" || input.reasoning?.effort === "none" || input.providerOptions?.enable_thinking === false;
      input.toolChoice = requiredChoiceSupported ? "required" : "auto";
    }
    if (state.phase !== "recover") {
      if (++state.verifierRequests > 2) throw new Error("REPAIR_VERIFIER_MISSING: candidate retained without verification.");
      const required = oci ? "repair_plan" : "run_check";
      if (!input.tools?.[required]) throw new Error("REPAIR_VERIFIER_UNAVAILABLE");
      input.tools = Object.fromEntries(Object.entries(input.tools).filter(([name]) => [required, "read_task"].includes(name)));
      const namedChoiceSupported = provider !== "qwen" || input.reasoning?.effort === "none" || input.providerOptions?.enable_thinking === false;
      input.toolChoice = namedChoiceSupported ? { type: "tool", toolName: required } : "auto";
    }
  };
  const synthetic = (call: ToolCall): GenerateResult => ({ message: { role: "assistant", parts: [{ type: "tool-call", toolCall: call }] },
    finishReason: "tool-calls", providerFinishReason: "harness-controller", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  const remind = (input: ModelGenerateInput, reason: unknown, usage: TokenUsage | undefined, sawTool: boolean): ToolCall | undefined => {
    input.abortSignal?.throwIfAborted();
    if (reason !== "stop" || sawTool || !completionPending() || state.completionReminders >= 1 || !input.tools?.read_task ||
      (state.planRequired && state.verifierRequests >= 2) ||
      (pending() && state.phase !== "recover" && !state.verifier && state.verifierRequests >= 2) ||
      !usage || ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return;
    state.completionReminders++;
    return { id: `controller_${randomUUID()}`, name: "read_task", input: {} };
  };
  const middleware: LanguageModelMiddleware = {
    name: "harness-repair-controller-v1",
    async wrapGenerate(context, next) {
      const call = prepare(context.input, context.model.provider);
      if (call) return synthetic(call);
      const result = await next();
      const messages = result.messages ?? (result.message ? [result.message] : []);
      const reminder = remind(context.input, result.finishReason, result.usage,
        messages.some(m => m.parts.some(p => p.type === "tool-call" || p.type === "tool-result")));
      if (!reminder) return result;
      const last = messages.at(-1);
      const message: ModelMessage = { role: "assistant", parts: [
        ...(last?.role === "assistant" ? last.parts : []), { type: "tool-call", toolCall: reminder }
      ] };
      return { ...result, message, messages: [...(last?.role === "assistant" ? messages.slice(0, -1) : messages), message],
        finishReason: "tool-calls", providerFinishReason: "harness-completion-reminder" };
    },
    async wrapStream(context, next) {
      const call = prepare(context.input, context.model.provider);
      if (!call) {
        const stream = await next();
        return (async function* (): AsyncIterable<StreamEvent> {
          let sawTool = false;
          let finish: Extract<StreamEvent, { type: "finish" }> | undefined;
          for await (const event of stream) {
            if (["tool-call", "tool-result", "tool-approval-request", "error"].includes(event.type)) sawTool = true;
            if (event.type === "finish") {
              if (finish) throw new Error("REPAIR_AMBIGUOUS_STREAM: multiple terminal events.");
              finish = event;
              continue;
            }
            yield event;
          }
          // Wait for normal stream completion: a finish followed by an error
          // cannot authorize a synthetic continuation.
          if (finish) {
            const reminder = remind(context.input, finish.finishReason, finish.usage, sawTool);
            if (reminder) yield { type: "tool-call", toolCall: reminder };
            yield reminder ? { ...finish, finishReason: "tool-calls", providerFinishReason: "harness-completion-reminder" } : finish;
          }
        })();
      }
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { type: "tool-call", toolCall: call };
        yield { type: "finish", finishReason: "tool-calls", providerFinishReason: "harness-controller", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      })();
    }
  };
  return { state, snapshot, pending, completionPending, closure, markIncomplete, verificationFailed, wrapTools, middleware };
};
