import { wrapLanguageModel, type LanguageModel, type ModelGenerateInput } from "@zhivex-ai/core";

/** Model Studio's Kimi K3 documentation currently requires Chat Completions and
 * thinking-only mode. Narrow the installed SDK snapshot until it catches up.
 * https://help.aliyun.com/en/model-studio/kimi-api (2026-09-26). */
export function withQwenHostedPolicy(model: LanguageModel): LanguageModel {
  if (model.modelId !== "kimi-k3") return model;
  const prepare = (input: ModelGenerateInput) => {
    const options = input.providerOptions ?? {};
    if (options.apiMode && !["auto", "chat"].includes(String(options.apiMode))) throw new Error("Kimi K3 on Model Studio requires Chat Completions.");
    if (input.reasoning?.effort !== undefined || input.reasoning?.budgetTokens !== undefined ||
        options.reasoning_effort !== undefined || options.thinking_budget !== undefined || options.enable_thinking === false) {
      throw new Error("Kimi K3 on Model Studio currently supports default thinking only.");
    }
    input.providerOptions = {...options, apiMode: "chat", enable_thinking: true};
  };
  const wrapped = wrapLanguageModel(model, [{
    name: "harness-kimi-k3-chat-thinking-v1",
    async wrapGenerate(context, next) {prepare(context.input);return next();},
    async wrapStream(context, next) {prepare(context.input);return next();},
  }]);
  return {...wrapped, capabilities: {...wrapped.capabilities, reasoningEfforts: [], webSearch: false,
    ...(wrapped.capabilities.agentCapabilities ? {agentCapabilities: {...wrapped.capabilities.agentCapabilities, hostedWebSearch: false, codeExecution: false, webExtraction: false}} : {})}};
}
