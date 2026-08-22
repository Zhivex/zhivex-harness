import { createHash, randomUUID } from "node:crypto";

import {
  applySafetyPolicyToAgent,
  createBudgetGuard,
  createProductionSafetyPolicy,
  runAgentGroup,
  type AgentDefinition,
  type AgentHarnessBinding,
  type AgentRunInput,
  type AgentSubAgentDefinition,
  type LanguageModel,
  type ToolSet
} from "@zhivex-ai/agents";
import type {
  AgentMemoryStore,
  AgentRunStore,
  AgentTelemetryObserver
} from "@zhivex-ai/agents/ops";

import type {
  HarnessConfig,
  HarnessSubagentProfile
} from "./config.js";

export interface HarnessSubagentProfileDescriptor {
  id: HarnessSubagentProfile;
  toolName: string;
  description: string;
  instructions: string;
  toolNames: readonly string[] | "all";
}

export const HARNESS_SUBAGENT_PROFILE_DESCRIPTORS: readonly HarnessSubagentProfileDescriptor[] = [
  {
    id: "explorer",
    toolName: "delegate_explorer",
    description: "Delegate bounded repository discovery to a read-only explorer.",
    instructions: "Inspect the repository with read-only tools. Return evidence with paths and concrete findings. Never propose or perform mutations.",
    toolNames: ["list_files", "read_file", "read_files", "search_files", "search_many", "load_skill", "git_diff"]
  },
  {
    id: "implementer",
    toolName: "delegate_implementer",
    description: "Delegate one bounded implementation task. Mutations and checks still require promoted operator approval.",
    instructions: "Implement only the delegated task. Inspect first, use digest-bound proposals, and finish with git_diff plus mutation_audit. Never bypass approvals.",
    toolNames: "all"
  },
  {
    id: "tester",
    toolName: "delegate_tester",
    description: "Delegate focused verification to a tester with read-only inspection and approved package-manager checks.",
    instructions: "Verify the delegated behavior with repository evidence and declared package-manager checks. Do not edit files. Report exact failures and limits.",
    toolNames: ["list_files", "read_file", "read_files", "search_files", "search_many", "load_skill", "run_check", "git_diff"]
  },
  {
    id: "reviewer",
    toolName: "delegate_reviewer",
    description: "Delegate an independent read-only review of correctness, safety, and regressions.",
    instructions: "Review the requested scope independently. Inspect concrete code and diffs, prioritize actionable defects, and do not mutate the workspace.",
    toolNames: ["list_files", "read_file", "read_files", "search_files", "search_many", "load_skill", "mutation_audit", "git_diff"]
  }
] as const;

export interface HarnessSubagentRuntime {
  definitions: AgentSubAgentDefinition<LanguageModel>[];
  agents: ReadonlyMap<HarnessSubagentProfile, AgentDefinition<LanguageModel>>;
}

const pickTools = (tools: ToolSet, names: readonly string[] | "all"): ToolSet => {
  if (names === "all") {
    return { ...tools };
  }
  return Object.fromEntries(names.flatMap((name) => tools[name] ? [[name, tools[name]]] : []));
};

const childHarnessBinding = (
  parent: AgentHarnessBinding,
  profile: HarnessSubagentProfile,
  model: LanguageModel,
  toolNames: readonly string[],
  config: HarnessConfig
): AgentHarnessBinding => ({
  schemaVersion: 1,
  id: `${parent.id}-${profile}`,
  version: parent.version,
  fingerprint: `sha256:${createHash("sha256").update(JSON.stringify({
    parent: parent.fingerprint,
    profile,
    model: {
      provider: model.provider,
      modelId: model.modelId,
      capabilities: model.capabilities
    },
    toolNames,
    budget: config.orchestration.childBudget,
    timeoutMs: config.orchestration.childTimeoutMs
  })).digest("hex")}`,
  algorithm: "sha256"
});

const providerCompatibleChildBudget = (config: HarnessConfig) => {
  const durable = createBudgetGuard(config.orchestration.childBudget);
  const transport = createBudgetGuard({
    maxSteps: config.orchestration.childBudget.maxSteps,
    maxToolCalls: config.orchestration.childBudget.maxToolCalls,
    maxToolErrors: config.orchestration.childBudget.maxToolErrors,
    includeChildRuns: false
  });
  return {
    ...transport,
    inputGuardrail: durable.inputGuardrail,
    outputGuardrail: durable.outputGuardrail
  };
};

export const createHarnessSubagents = (options: {
  config: HarnessConfig;
  parentBinding: AgentHarnessBinding;
  model: LanguageModel;
  models?: Partial<Record<HarnessSubagentProfile, LanguageModel>>;
  tools: ToolSet;
  store: AgentRunStore;
  memory?: AgentMemoryStore;
  onTelemetryEvent?: AgentTelemetryObserver;
  contextInstructions?: string;
}): HarnessSubagentRuntime => {
  const definitions: AgentSubAgentDefinition<LanguageModel>[] = [];
  const agents = new Map<HarnessSubagentProfile, AgentDefinition<LanguageModel>>();
  for (const profileId of options.config.orchestration.profiles) {
    const descriptor = HARNESS_SUBAGENT_PROFILE_DESCRIPTORS.find((entry) => entry.id === profileId);
    if (!descriptor) continue;
    const model = options.models?.[profileId] ?? options.model;
    const selectedTools = pickTools(options.tools, descriptor.toolNames);
    const selectedToolNames = Object.keys(selectedTools).sort();
    const baseAgent: AgentDefinition<LanguageModel> = {
      id: `zhivex-harness-${profileId}`,
      model,
      instructions: `${descriptor.instructions}${options.contextInstructions ? `\n\n${options.contextInstructions}` : ""}`,
      maxSteps: options.config.orchestration.childBudget.maxSteps,
      tools: selectedTools,
      harness: childHarnessBinding(options.parentBinding, profileId, model, selectedToolNames, options.config),
      policy: {
        timeoutMs: options.config.orchestration.childTimeoutMs,
        maxStateBytes: 2 * 1024 * 1024,
        leaseMode: "required"
      },
      metadata: {
        harnessVersion: options.parentBinding.version,
        role: profileId,
        orchestration: "bounded-subagent"
      },
      store: options.store,
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.onTelemetryEvent ? { onTelemetryEvent: options.onTelemetryEvent } : {}),
      hookFailurePolicy: {
        telemetry: "ignore",
        memory: "ignore"
      }
    };
    const agent = applySafetyPolicyToAgent(baseAgent, createProductionSafetyPolicy({
      budget: providerCompatibleChildBudget(options.config),
      toolExecution: { parallel: false, stopOnError: true }
    }));
    agents.set(profileId, agent);
    definitions.push({
      name: descriptor.toolName,
      description: descriptor.description,
      agent,
      maxSteps: options.config.orchestration.childBudget.maxSteps,
      metadata: {
        profile: profileId,
        bounded: true
      }
    });
  }
  return { definitions, agents };
};

export interface HarnessReviewGroupResult {
  schemaVersion: 1;
  kind: "review-group";
  groupId: string;
  status: "completed" | "failed";
  profiles: HarnessSubagentProfile[];
  outputs: Awaited<ReturnType<typeof runAgentGroup>>["outputs"];
}

export const runHarnessReviewGroup = async (
  runtime: {
    config: HarnessConfig;
    subagents: ReadonlyMap<HarnessSubagentProfile, AgentDefinition<LanguageModel>>;
  },
  input: {
    prompt: string;
    scope?: AgentRunInput<LanguageModel>["scope"];
    abortSignal?: AbortSignal;
    metadata?: AgentRunInput<LanguageModel>["metadata"];
    groupId?: string;
  },
  profiles: readonly HarnessSubagentProfile[] = ["explorer", "reviewer"]
): Promise<HarnessReviewGroupResult> => {
  const uniqueProfiles = [...new Set(profiles)];
  if (uniqueProfiles.length === 0) {
    throw new Error("A review group requires at least one profile.");
  }
  if (uniqueProfiles.length > runtime.config.orchestration.maxParallelReviews) {
    throw new Error(
      `Review group exceeds maxParallelReviews=${runtime.config.orchestration.maxParallelReviews}.`
    );
  }
  const unsafe = uniqueProfiles.find((profile) => profile !== "explorer" && profile !== "reviewer");
  if (unsafe) {
    throw new Error(`Parallel review accepts read-only explorer/reviewer profiles, not ${unsafe}.`);
  }
  const members = uniqueProfiles.map((profile) => {
    const agent = runtime.subagents.get(profile);
    if (!agent) {
      throw new Error(`Subagent profile ${profile} is not enabled.`);
    }
    return { name: profile, agent };
  });
  const groupId = input.groupId ?? `review_${randomUUID()}`;
  const result = await runAgentGroup(members, {
    prompt: input.prompt,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    parentRunId: groupId,
    metadata: {
      ...(input.metadata ?? {}),
      orchestration: "application-owned-review-group",
      groupId
    },
    stopOnError: false
  });
  return {
    schemaVersion: 1,
    kind: "review-group",
    groupId,
    status: result.status,
    profiles: uniqueProfiles,
    outputs: result.outputs
  };
};
