import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentExecutionEnvironmentBinding } from "@zhivex-ai/agents/beta";

import {
  PROVIDERS,
  providerDescriptor,
  type HarnessProvider
} from "../src/config.js";
import { createHarness, runHarness } from "../src/harness.js";
import { liveProviderSmokeInternals } from "./live-provider-smoke.js";

const {
  assertLiveOptIn,
  errorEvidence,
  providerRunInput,
  redacted,
  requireCredentials,
  selectedProviders
} = liveProviderSmokeInternals;

const modelEnvironmentName = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`;

const executionPath = (provider: HarnessProvider) => `live-execution/${provider}.txt`;
const executionContent = (provider: HarnessProvider) => `${provider} enforced OCI live smoke\n`;
const completionToken = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_${provider.toUpperCase()}_OCI_LIVE_OK`;

export const executionCommandInput = (provider: HarnessProvider) => ({
  command: "node",
  args: [
    "--input-type=module",
    "-e",
    `import { mkdir, writeFile } from 'node:fs/promises'; await mkdir('live-execution',{recursive:true}); await writeFile(${JSON.stringify(executionPath(provider))},${JSON.stringify(executionContent(provider))})`
  ]
});

export const executionPrompt = (provider: HarnessProvider) =>
  `Perform this exact enforced-environment workflow:
1. Call run_environment_command exactly once with this exact JSON input: ${JSON.stringify(executionCommandInput(provider))}.
2. Call inspect_environment_patch exactly once with {}.
3. Read patchId from that tool result, then call apply_environment_patch exactly once with that unchanged patchId.
Do not call any other tool, do not invent the patchId, and do not write through repository editing tools.
After the approved patch import result, reply exactly ${completionToken(provider)}.`;

const certifyProvider = async (
  provider: HarnessProvider,
  model: string,
  workspace: string,
  stateDirectory: string
) => {
  const harness = await createHarness({
    provider,
    model,
    workspace,
    stateDirectory,
    executionBackend: "oci",
    ...(process.env.ZHIVEX_HARNESS_OCI_IMAGE
      ? { ociImage: process.env.ZHIVEX_HARNESS_OCI_IMAGE }
      : {}),
    ociAllowedCommands: ["node", "npm"],
    ociMaxProcessRuntimeMs: 30_000,
    ociMaxMemoryMb: 256,
    ociMaxPids: 32,
    ociMaxCpus: 1,
    ociMaxWorkspaceBytes: 8 * 1024 * 1024,
    ociTmpfsMb: 64,
    maxSteps: 6,
    maxToolCalls: 8,
    subagentProfiles: [],
    env: process.env
  });
  const approvals: Array<{ name: string; arguments: unknown }> = [];
  try {
    const result = await runHarness(harness, {
      ...providerRunInput(provider, executionPrompt(provider)),
      maxSteps: 6,
      scope: harness.config.scope,
      idempotencyKey: `live-execution-${provider}`
    }, {
      resolveApprovals: async (pending) => pending.map((approval) => {
        assert.ok(
          approval.name === "run_environment_command" || approval.name === "apply_environment_patch",
          `Unexpected live execution approval: ${approval.name}.`
        );
        const argumentsValue = JSON.parse(approval.arguments) as unknown;
        approvals.push({ name: approval.name, arguments: argumentsValue });
        if (approval.name === "run_environment_command") {
          assert.deepEqual(argumentsValue, executionCommandInput(provider));
        } else {
          assert.match((argumentsValue as { patchId?: string }).patchId ?? "", /^sha256:[a-f0-9]{64}$/);
        }
        return {
          provider: approval.provider,
          approvalRequestId: approval.id,
          approve: true,
          reason: "Opt-in live enforced-execution certification."
        };
      })
    });

    assert.equal(result.status, "completed", result.outputText || result.error?.message);
    assert.ok(result.outputText.includes(completionToken(provider)), result.outputText);
    assert.deepEqual(approvals.map((approval) => approval.name), [
      "run_environment_command",
      "apply_environment_patch"
    ]);
    const expectedTools = [
      "run_environment_command",
      "inspect_environment_patch",
      "apply_environment_patch"
    ];
    assert.deepEqual(result.toolResults.map((entry) => entry.toolName), expectedTools);
    assert.ok(result.toolResults.every((entry) => !entry.isError));
    assert.equal(
      await readFile(path.join(workspace, executionPath(provider)), "utf8"),
      executionContent(provider)
    );
    assert.deepEqual(
      result.state.executionEnvironment,
      createAgentExecutionEnvironmentBinding(harness.executionEnvironment!.manifest)
    );
    const journal = await harness.store.listToolCalls?.(result.state.runId, harness.config.scope);
    for (const toolName of ["run_environment_command", "apply_environment_patch"]) {
      const entries = journal?.filter((entry) => entry.toolName === toolName) ?? [];
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.status, "completed");
    }
    return {
      ok: true as const,
      provider,
      model,
      runId: result.state.runId,
      imageDigest: harness.executionEnvironment!.image.imageDigest,
      approvals: approvals.map((approval) => approval.name),
      toolSequence: expectedTools,
      hostImportVerified: true,
      environmentBound: true
    };
  } finally {
    await harness.close();
  }
};

const executionError = (error: unknown, env: NodeJS.ProcessEnv) => {
  const base = JSON.parse(errorEvidence(error, env)) as { error: Record<string, unknown> };
  return base.error;
};

const run = async (env: NodeJS.ProcessEnv) => {
  assertLiveOptIn(env);
  const providers = selectedProviders(env);
  requireCredentials(providers, env);
  const evidence: Array<Record<string, unknown>> = [];

  for (const provider of providers) {
    const model = env[modelEnvironmentName(provider)]?.trim() || providerDescriptor(provider).defaultModel;
    const workspace = await mkdtemp(path.join(os.tmpdir(), `zhivex-harness-live-oci-${provider}-`));
    const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
    try {
      evidence.push(await certifyProvider(provider, model, workspace, stateDirectory));
    } catch (error) {
      evidence.push({ ok: false, provider, model, error: executionError(error, env) });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  const ok = evidence.every((entry) => entry.ok === true);
  process.stdout.write(`${JSON.stringify({
    ok,
    gate: "live-execution-smoke",
    certifiedAt: new Date().toISOString(),
    providers: evidence
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
};

export const liveExecutionSmokeInternals = {
  executionCommandInput,
  executionPrompt,
  completionToken
};

if (import.meta.main) {
  run(process.env).catch((error: unknown) => {
    process.stderr.write(redacted(JSON.stringify({
      ok: false,
      gate: "live-execution-smoke",
      error: executionError(error, process.env)
    }, null, 2), process.env));
    process.stderr.write("\n");
    process.exitCode = 1;
  });
}
