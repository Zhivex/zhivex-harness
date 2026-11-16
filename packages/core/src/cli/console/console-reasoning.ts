import { modelReasoningEfforts, type HarnessReasoningEffort } from "../../providers/reasoning.js";
import type { ConsoleInput } from "./console-input.js";

const descriptions: Record<HarnessReasoningEffort, string> = {
  default: "Provider default; send no effort override", none: "Disable reasoning where supported",
  minimal: "Smallest reasoning effort", low: "Lighter reasoning for focused changes",
  medium: "Balance reasoning depth and latency", high: "Deeper reasoning for complex tasks",
  xhigh: "Extra reasoning; higher latency and token use", max: "Maximum supported reasoning effort"
};
export const chooseReasoning = async (input: Pick<ConsoleInput, "select">, provider: string, model: string,
  current?: HarnessReasoningEffort): Promise<HarnessReasoningEffort | undefined> => {
  const efforts = modelReasoningEfforts(provider, model);
  if (current && efforts.includes(current)) efforts.sort((a, b) => Number(b === current) - Number(a === current));
  return input.select(`Zhivex / ${model} / Reasoning\n${efforts.length === 1 ? "No configurable levels declared by this adapter; provider default only" : "Higher effort can take longer and use more tokens"}`, efforts.map(value => ({
    value, label: `${value}${value === (current ?? "default") ? " (current)" : ""}`, detail: descriptions[value]
  })));
};
