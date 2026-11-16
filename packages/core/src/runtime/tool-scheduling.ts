import type { ToolExecutionOptions, ToolSet } from "@zhivex-ai/core";

// Provenance is an object-identity assertion from the host, never a remote tool claim.
const reads = new Set(["list_files", "read_file", "read_files", "search_files", "search_many", "read_dependency"]);
export const scheduleLocalReads = (tools: ToolSet, trustedLocalTools: ToolSet, maxConcurrency = 4): {
  tools: ToolSet; toolExecution: ToolExecutionOptions;
} => {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
    throw new Error("Tool read concurrency must be an integer between 1 and 8.");
  }
  return {
    tools: Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name,
      "execute" in definition ? { ...definition, independent: trustedLocalTools[name] === definition &&
        reads.has(name) && definition.metadata?.type !== "subagent" && !definition.requiresApproval && definition.approvalMode !== "interrupt" } : definition
    ])),
    toolExecution: { parallel: true, independentOnly: true, maxConcurrency }
  };
};
