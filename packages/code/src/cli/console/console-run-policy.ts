import { z } from "zod";
import type { AgentRunState } from "@zhivex-ai/agents";
import type { CliOptions } from "../arguments.js";

const key = "zhivexCodeNextRunPolicy";
const schema = z.strictObject({ schemaVersion: z.literal(1), pricingFile: z.string().min(1).max(4096).optional(),
  usageLimitUsd: z.number().finite().positive().optional() });

/** Console defaults for new runs only. The engine ledger owns resumed-run policy. */
export const consoleRunPolicyMetadata = (options: CliOptions): NonNullable<AgentRunState["metadata"]> => {
  const saved = schema.parse({ schemaVersion: 1,
  ...(options.pricingFile ? { pricingFile: options.pricingFile } : {}),
  ...(options.usageLimitUsd !== undefined ? { usageLimitUsd: options.usageLimitUsd } : {}) });
  return { [key]: { schemaVersion: saved.schemaVersion,
    ...(saved.pricingFile ? { pricingFile: saved.pricingFile } : {}),
    ...(saved.usageLimitUsd !== undefined ? { usageLimitUsd: saved.usageLimitUsd } : {}) } };
};

export const restoreConsoleRunPolicy = (options: CliOptions, state: Pick<AgentRunState, "metadata">): CliOptions => {
  if (state.metadata?.[key] === undefined) return options;
  const saved = schema.parse(state.metadata[key]);
  const next = { ...options }; delete next.pricingFile; delete next.usageLimitUsd;
  return { ...next, ...(saved.pricingFile ? { pricingFile: saved.pricingFile } : {}),
    ...(saved.usageLimitUsd !== undefined ? { usageLimitUsd: saved.usageLimitUsd } : {}) };
};
