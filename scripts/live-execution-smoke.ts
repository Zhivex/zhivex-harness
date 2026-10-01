import { loadLiveSmokeRuntime } from "./live-smoke-runtime.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  selectedProviders,
  throwTransientRunFailure
} = liveProviderSmokeInternals;

const modelEnvironmentName = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`;

const executionPath = (provider: HarnessProvider) => `live-execution/${provider}.txt`;
const executionContent = (provider: HarnessProvider) => `${provider} enforced OCI live smoke\n`;
const completionToken = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_${provider.toUpperCase()}_OCI_LIVE_OK`;

export const EXECUTION_FIXTURE_NAME = "live-execution-fixture.mjs";
// The host owns the program. The model selects a reviewed argv, rather than
// reproducing JavaScript source whose harmless rewrites invalidate certification.
export const executionFixtureSource = (provider: HarnessProvider) => `import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const provider = ${JSON.stringify(provider)};
assert(${JSON.stringify(PROVIDERS)}.includes(provider));
await mkdir('live-execution', { recursive: true });
await writeFile('live-execution/' + provider + '.txt', provider + ' enforced OCI live smoke\\n');
`;

export const executionCommandInput = (provider: HarnessProvider) => ({
  command: "node",
  args: [EXECUTION_FIXTURE_NAME]
});

const executionArgumentValueType = (value: unknown) => {
  if (value === null) return "null" as const;
  if (Array.isArray(value)) return "array" as const;
  if (value === undefined) return "undefined" as const;
  return typeof value as "boolean" | "number" | "object" | "string";
};

const executionArgumentsDiagnostic = (actual: unknown, expected: ReturnType<typeof executionCommandInput>) => {
  const isRecord = actual !== null && typeof actual === "object" && !Array.isArray(actual);
  const record = isRecord ? actual as Record<string, unknown> : undefined;
  const commandPresent = record !== undefined && Object.hasOwn(record, "command");
  const argsPresent = record !== undefined && Object.hasOwn(record, "args");
  const command = record?.command;
  const args = record?.args;
  const arrayArgs = Array.isArray(args) ? args as unknown[] : undefined;
  const argumentMismatches = arrayArgs
    ? expected.args.flatMap((expectedValue, index) => {
        const value = Object.hasOwn(arrayArgs, index) ? arrayArgs[index] : undefined;
        const actualType = executionArgumentValueType(value);
        const matchesExpected = typeof value === "string" && value === expectedValue;
        if (matchesExpected) return [];
        const nestedMemberCount = value !== null && typeof value === "object"
          ? Math.min(Array.isArray(value) ? value.length : Object.keys(value).length, 1_000)
          : undefined;
        return [{ index, actualType, matchesExpected, ...(nestedMemberCount === undefined ? {} : { nestedMemberCount }) }];
      })
    : [];
  const rootKeys = record ? Object.keys(record) : [];
  return {
    rootType: executionArgumentValueType(actual),
    commandPresent,
    commandType: executionArgumentValueType(commandPresent ? command : undefined),
    commandMatchesExpected: typeof command === "string" && command === expected.command,
    argsPresent,
    argsType: executionArgumentValueType(argsPresent ? args : undefined),
    expectedArgCount: expected.args.length,
    ...(arrayArgs ? { actualArgCount: Math.min(arrayArgs.length, 1_000) } : {}),
    extraArgCount: arrayArgs ? Math.min(Math.max(0, arrayArgs.length - expected.args.length), 1_000) : 0,
    extraFieldCount: Math.min(rootKeys.filter((key) => key !== "command" && key !== "args").length, 1_000),
    argumentMismatches
  };
};

const assertExecutionCommandArguments = (actual: unknown, provider: HarnessProvider) => {
  const expected = executionCommandInput(provider);
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    if (error && typeof error === "object") {
      Object.assign(error, { executionArguments: executionArgumentsDiagnostic(actual, expected) });
    }
    throw error;
  }
};

export const executionPrompt = (provider: HarnessProvider) =>
  `Perform this exact enforced-environment workflow:
1. Call run_environment_command exactly once with this exact JSON input: ${JSON.stringify(executionCommandInput(provider))}.
2. Call inspect_environment_patch exactly once with {}.
3. Call apply_environment_patch exactly once with {}. The runtime binds the inspected patch internally.
Do not call any other tool, do not supply a patchId, and do not write through repository editing tools.
After the approved patch import result, reply exactly ${completionToken(provider)}.`;

const assertExecutionRunStatus = (result: { status: string; outputText?: string; error?: { message?: string } }) => {
  throwTransientRunFailure(result);
  if (result.status === "failed" && result.error) {
    throw new HarnessExecutionError("Live execution run failed.", { cause: result.error });
  }
  assert.equal(result.status, "completed", result.outputText || result.error?.message || "Unexpected run status");
};

const certifyProvider = async (
  provider: HarnessProvider,
  model: string,
  workspace: string,
  stateDirectory: string
) => {
  await writeFile(path.join(workspace, EXECUTION_FIXTURE_NAME), executionFixtureSource(provider), { mode: 0o444 });
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
    toolNames: ["run_environment_command", "inspect_environment_patch", "apply_environment_patch"],
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
          assertExecutionCommandArguments(argumentsValue, provider);
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
    assertExecutionRunStatus(result);
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
    assert.equal(await readFile(path.join(workspace, EXECUTION_FIXTURE_NAME), "utf8"), executionFixtureSource(provider),
      "The approved OCI command must not modify its host-owned fixture.");
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
  assertExecutionRunStatus,
  assertExecutionCommandArguments,
  executionArgumentsDiagnostic,
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
