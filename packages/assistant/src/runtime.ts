import { createProfiledHarness, runHarness, GENERAL_ASSISTANT_PROFILE, type CreateProfiledHarnessOptions } from "@zhivex-ai/harness/engine";

/** Trusted local bootstrap only. Channel payloads must never construct these options. */
export interface AssistantRuntimeOptions {
  workspace: string;
  ownerId: string;
  modelInstance: NonNullable<CreateProfiledHarnessOptions["modelInstance"]>;
}

/** Phase-zero proof: no tools, delegation or project context. Not a daemon/session host. */
export async function createAssistantRuntime(options: AssistantRuntimeOptions) {
  if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(options.ownerId)) throw new Error("Invalid owner ID");
  const harness = await createProfiledHarness({
    workspace: options.workspace,
    modelInstance: options.modelInstance,
    agentProfile: GENERAL_ASSISTANT_PROFILE,
    tenantId: "assistant-local", userId: options.ownerId, namespace: "assistant-v1",
    toolNames: [], subagentProfiles: [], projectContext: false, projectMemory: false,
    maxSteps: 4, maxToolCalls: 1, timeoutMs: 30_000
  });
  return {
    async runTask(prompt: string) {
      if (!prompt.trim() || prompt.length > 16000) throw new Error("Expected a bounded nonempty prompt");
      const result = await runHarness(harness, { prompt });
      return { runId: result.state.runId, status: result.status, outputText: result.outputText };
    },
    close: () => harness.close()
  };
}
