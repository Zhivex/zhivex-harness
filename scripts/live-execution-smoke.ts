import { loadLiveSmokeRuntime } from "./live-smoke-runtime.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentExecutionEnvironmentBinding } from "@zhivex-ai/agents/beta";

import type { HarnessProvider } from "../src/runtime/config.js";
import { liveProviderSmokeInternals } from "./live-provider-smoke.js";

const { PROVIDERS, providerDescriptor, createHarness, runHarness, HarnessExecutionError } = await loadLiveSmokeRuntime();

const {
  assertLiveOptIn,
  errorEvidence,
  providerCredentialFailure,
  providerHasCredentials,
  providerRunInput,
  redacted,
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
3. Call apply_environment_patch exactly once with {}. The runtime binds the inspected patch internally.
Do not call any other tool, do not supply a patchId, and do not write through repository editing tools.
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
  let checkpoint: string | undefined;
  const approvals: Array<{ name: string; arguments: unknown }> = [];
  try {
    const result = await runHarness(harness, {
      ...providerRunInput(provider, executionPrompt(provider)),
      maxSteps: 6,
      scope: harness.config.scope,
      idempotencyKey: `live-execution-${provider}`
    }, {
      resolveApprovals: async (pending) => pending.map((approval) => {
        checkpoint = "execution_approval_tool";
        assert.ok(
          approval.name === "run_environment_command" || approval.name === "apply_environment_patch",
          `Unexpected live execution approval: ${approval.name}.`
        );
        const argumentsValue = JSON.parse(approval.arguments) as unknown;
        approvals.push({ name: approval.name, arguments: argumentsValue });
        if (approval.name === "run_environment_command") {
          checkpoint = "execution_command_arguments";
          assert.deepEqual(argumentsValue, executionCommandInput(provider));
        } else {
          checkpoint = "execution_import_reference";
          assert.match((argumentsValue as { patchId?: string }).patchId ?? "", /^sha256:[a-f0-9]{64}$/);
        }
        checkpoint = undefined;
        return {
          provider: approval.provider,
          approvalRequestId: approval.id,
          approve: true,
          reason: "Opt-in live enforced-execution certification."
        };
      })
    });

    checkpoint = "execution_run_status";
    if (result.status === "failed" && result.error) {
      throw new HarnessExecutionError("Live execution run failed.", { cause: result.error });
    }
    assert.equal(result.status, "completed", result.outputText || result.error?.message || "Unexpected run status");
    checkpoint = "execution_completion_marker";
    assert.ok(result.outputText.includes(completionToken(provider)), result.outputText);
    checkpoint = "execution_approval_sequence";
    assert.deepEqual(approvals.map((approval) => approval.name), [
      "run_environment_command",
      "apply_environment_patch"
    ]);
    const expectedTools = [
      "run_environment_command",
      "inspect_environment_patch",
      "apply_environment_patch"
    ];
    checkpoint = "execution_tool_sequence";
    assert.deepEqual(result.toolResults.map((entry) => entry.toolName), expectedTools);
    checkpoint = "execution_tool_success";
    assert.ok(result.toolResults.every((entry) => !entry.isError));
    checkpoint = "execution_host_content";
    assert.equal(
      await readFile(path.join(workspace, executionPath(provider)), "utf8"),
      executionContent(provider)
    );
    checkpoint = "execution_environment_binding";
    assert.deepEqual(
      result.state.executionEnvironment,
      createAgentExecutionEnvironmentBinding(harness.executionEnvironment!.manifest)
    );
    checkpoint = "execution_journal";
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
  } catch (error) {
    throw Object.assign(new HarnessExecutionError("Live execution certification failed.", { cause: error }),
      checkpoint ? { checkpoint } : {});
  } finally {
    await harness.close();
  }
};

const executionError = (error: unknown, env: NodeJS.ProcessEnv) => {
  const base = JSON.parse(errorEvidence(error, env, "live-execution-smoke")) as {
    error: Record<string, unknown>;
  };
  return base.error;
};

const run = async (env: NodeJS.ProcessEnv) => {
  assertLiveOptIn(env);
  const providers = selectedProviders(env);
  const evidence: Array<Record<string, unknown>> = [];

  for (const provider of providers) {
    if (env.ZHIVEX_HARNESS_LIVE_FAIL_FAST === "1" && evidence.some((entry) => entry.ok === false)) break;
    const model = env[modelEnvironmentName(provider)]?.trim() || providerDescriptor(provider).defaultModel;
    if (!providerHasCredentials(provider, env)) {
      evidence.push({ ok: false, provider, model, error: providerCredentialFailure(provider) });
      continue;
    }
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
