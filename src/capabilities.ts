import type { LanguageModel } from "@zhivex-ai/agents";

import type { HarnessRequiredCapability } from "./config.js";

export interface HarnessModelCapabilityReport {
  provider: string;
  model: string;
  supportTier?: string;
  capabilities: Record<HarnessRequiredCapability, boolean>;
}

export interface HarnessModelCandidate {
  id?: string;
  model: LanguageModel;
  priority?: number;
}

export interface HarnessModelSelection {
  id?: string;
  model: LanguageModel;
  report: HarnessModelCapabilityReport;
  score: number;
}

export const inspectHarnessModelCapabilities = (
  model: LanguageModel
): HarnessModelCapabilityReport => ({
  provider: model.provider,
  model: model.modelId,
  ...(model.capabilities.agentCapabilities?.supportTier
    ? { supportTier: model.capabilities.agentCapabilities.supportTier }
    : {}),
  capabilities: {
    streaming: model.capabilities.streaming && typeof model.stream === "function",
    tools: model.capabilities.tools,
    "structured-output": model.capabilities.structuredOutput,
    "parallel-tools": model.capabilities.parallelToolCalls,
    reasoning: model.capabilities.reasoning,
    "web-search": model.capabilities.webSearch
  }
});

export const assertHarnessModelCapabilities = (
  model: LanguageModel,
  required: readonly HarnessRequiredCapability[],
  context = "run"
) => {
  const report = inspectHarnessModelCapabilities(model);
  const missing = required.filter((capability) => !report.capabilities[capability]);
  if (missing.length > 0) {
    throw new Error(
      `Model ${report.provider}/${report.model} cannot enter the ${context}: missing ${missing.join(", ")}.`
    );
  }
  return report;
};

export const selectHarnessModel = (
  candidates: readonly HarnessModelCandidate[],
  required: readonly HarnessRequiredCapability[]
): HarnessModelSelection => {
  if (candidates.length === 0) {
    throw new Error("At least one model candidate is required.");
  }
  const compatible = candidates.flatMap((candidate, index) => {
    const report = inspectHarnessModelCapabilities(candidate.model);
    if (required.some((capability) => !report.capabilities[capability])) {
      return [];
    }
    const capabilityScore = Object.values(report.capabilities).filter(Boolean).length;
    return [{
      candidate,
      report,
      index,
      score: (candidate.priority ?? 0) * 100 + capabilityScore
    }];
  });
  compatible.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = compatible[0];
  if (!selected) {
    throw new Error(
      `No model candidate satisfies required capabilities: ${required.join(", ") || "none"}.`
    );
  }
  return {
    ...(selected.candidate.id ? { id: selected.candidate.id } : {}),
    model: selected.candidate.model,
    report: selected.report,
    score: selected.score
  };
};
