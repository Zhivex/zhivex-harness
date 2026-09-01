import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRunInput } from "@zhivex-ai/agents";

import {
  PROVIDERS,
  PROVIDER_DESCRIPTORS,
  providerDescriptor,
  type HarnessProvider
} from "../src/config.js";
import { createEditProposal } from "../src/edit-contracts.js";
import { HarnessConfigError } from "../src/errors.js";
import { createHarness, runHarness } from "../src/harness.js";
import {
  restoreSanitizedOperationalError,
  sanitizeOperationalError
} from "./release-diagnostics.js";

const OPT_IN_VARIABLE = "ZHIVEX_HARNESS_LIVE";
const PROVIDERS_VARIABLE = "ZHIVEX_HARNESS_LIVE_PROVIDERS";
const CHILD_MARKER = "ZHIVEX_HARNESS_LIVE_CHILD";
const PHASE_TIMEOUT_MS = 180_000;
const MAX_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_RETRY_DELAY_MS = 5_000;

interface PhaseArguments {
  phase: "request" | "resume";
  provider: HarnessProvider;
  model: string;
  workspace: string;
  stateDirectory: string;
  runId?: string;
}

interface RequestPhaseOutput {
  phase: "request";
  provider: HarnessProvider;
  model: string;
  runId: string;
  approvalId: string;
}

interface ResumePhaseOutput {
  phase: "resume";
  provider: HarnessProvider;
  model: string;
  runId: string;
  toolExecutions: number;
  journalEntries: number;
}

type PhaseOutput = RequestPhaseOutput | ResumePhaseOutput;

const modelEnvironmentName = (provider: HarnessProvider) =>
  `ZHIVEX_HARNESS_LIVE_${provider.toUpperCase()}_MODEL`;

const selectedProviders = (env: NodeJS.ProcessEnv): HarnessProvider[] => {
  const configured = env[PROVIDERS_VARIABLE]?.trim();
  if (!configured) {
    return PROVIDER_DESCRIPTORS
      .filter((descriptor) => descriptor.support === "certified")
      .map((descriptor) => descriptor.id);
  }
  const selected = [...new Set(configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
  for (const provider of selected) {
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`Unknown provider in ${PROVIDERS_VARIABLE}: ${provider}.`);
    }
  }
  if (selected.length === 0) {
    throw new Error(`${PROVIDERS_VARIABLE} must select at least one provider.`);
  }
  return selected as HarnessProvider[];
};

const providerHasCredentials = (provider: HarnessProvider, env: NodeJS.ProcessEnv) => {
  const descriptor = providerDescriptor(provider);
  return descriptor.credentialNames.some((name) => Boolean(env[name]?.trim()));
};

const providerCredentialFailure = (provider: HarnessProvider) =>
  sanitizeOperationalError(new HarnessConfigError(`Missing live credentials for ${provider}.`));

const requireCredentials = (providers: readonly HarnessProvider[], env: NodeJS.ProcessEnv) => {
  const missing = providers.filter((provider) => !providerHasCredentials(provider, env));
  if (missing.length > 0) {
    throw new HarnessConfigError(`Missing live credentials for: ${missing.join(", ")}.`);
  }
};

const assertLiveOptIn = (env: NodeJS.ProcessEnv) => {
  if (env[OPT_IN_VARIABLE] !== "1") {
    throw new Error(`Refusing live requests without ${OPT_IN_VARIABLE}=1.`);
  }
};

const transientProviderStatus = (error: unknown) => {
  const candidate = error && typeof error === "object"
    ? error as { message?: unknown; status?: unknown; statusCode?: unknown }
    : undefined;
  const statusValue = candidate?.status ?? candidate?.statusCode;
  const status = typeof statusValue === "number" ? statusValue : Number(statusValue);
  if (status === 408 || status === 425 || status === 429 || status === 500 ||
    status === 502 || status === 503 || status === 504) {
    return status;
  }
  if (typeof candidate?.message !== "string") return undefined;
  const match = candidate.message.match(/(?:^|[^\d])(408|425|429|500|502|503|504)(?=$|[^\d])/);
  return match ? Number(match[1]) : undefined;
};

const isTransientProviderFailure = (error: unknown) => transientProviderStatus(error) !== undefined;

const throwTransientRunFailure = (result: { status: string; error?: unknown }) => {
  if (result.status !== "failed" || !result.error) return;
  const status = transientProviderStatus(result.error);
  if (status === undefined) return;
  const message = (result.error as { message?: unknown }).message;
  throw Object.assign(
    new Error(typeof message === "string" ? message : `Provider request failed with status ${status}.`),
    { status }
  );
};

const redacted = (value: string, env: NodeJS.ProcessEnv) => {
  let result = value;
  const sensitiveNames = new Set([
    "META_BASE_URL",
    "OPENAI_BASE_URL",
    "GEMINI_BASE_URL",
    "QWEN_BASE_URL",
    "QWEN_WORKSPACE_ID",
    ...PROVIDERS.flatMap((provider) => providerDescriptor(provider).credentialNames)
  ]);
  for (const name of sensitiveNames) {
    const secret = env[name]?.trim();
    if (secret) {
      result = result.split(secret).join("[REDACTED]");
    }
  }
  return result;
};

const valueAfter = (argv: string[], index: number, option: string) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
};

const parsePhaseArguments = (argv: string[]): PhaseArguments | undefined => {
  if (!argv.includes("--phase")) {
    return undefined;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option?.startsWith("--")) {
      throw new Error(`Unexpected phase argument: ${option}.`);
    }
    values.set(option, valueAfter(argv, index, option));
    index += 1;
  }
  const phase = values.get("--phase");
  const provider = values.get("--provider");
  const model = values.get("--model");
  const workspace = values.get("--workspace");
  const stateDirectory = values.get("--state-dir");
  const runId = values.get("--run-id");
  if (phase !== "request" && phase !== "resume") {
    throw new Error("Live child phase must be request or resume.");
  }
  if (!provider || !(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Invalid live child provider: ${provider}.`);
  }
  if (!model || !workspace || !stateDirectory) {
    throw new Error("Live child phase is missing model, workspace, or state directory.");
  }
  if (phase === "resume" && !runId) {
    throw new Error("Live resume phase is missing runId.");
  }
  return {
    phase,
    provider: provider as HarnessProvider,
    model,
    workspace,
    stateDirectory,
    ...(runId ? { runId } : {})
  };
};

const certificationPath = (provider: HarnessProvider) => `live-certification/${provider}.txt`;
const certificationContent = (provider: HarnessProvider) => `${provider} live smoke\n`;
const completionToken = (provider: HarnessProvider) => `ZHIVEX_HARNESS_${provider.toUpperCase()}_LIVE_OK`;

const liveProviderOptions = (provider: HarnessProvider) => provider === "openai"
  ? { providerOptions: { apiMode: "responses" } }
  : provider === "qwen"
    ? { providerOptions: { apiMode: "responses" } }
    : {};

const providerRunInput = (provider: HarnessProvider, prompt: string): AgentRunInput => ({
  prompt,
  maxSteps: 4,
  toolChoice: "auto" as const,
  ...liveProviderOptions(provider)
});

const expectedApprovalArguments = (provider: HarnessProvider) => {
  const changes = [{
    path: certificationPath(provider),
    expectedDigest: null,
    content: certificationContent(provider)
  }];
  return {
    proposalId: createEditProposal({ changes }).proposalId,
    changes
  };
};

const certificationPrompt = (provider: HarnessProvider) => {
  const { changes } = expectedApprovalArguments(provider);
  return `Perform this exact reviewed-edit workflow:
1. Call propose_edits exactly once with this exact JSON input: ${JSON.stringify({ changes })}.
2. Read proposalId from that tool result, then call apply_patch exactly once with that proposalId and the same changes.
The expectedDigest field is required in both calls. Keep it present with the explicit JSON value null; never omit it.
Calling apply_patch is how you request operator approval: the runtime will pause before executing it. Do not ask for approval in text and do not finish after propose_edits.
Do not invent or calculate proposalId, do not skip propose_edits, and do not call any other tool.
After the approved apply_patch result, reply exactly ${completionToken(provider)}.`;
};

const createLiveHarness = async (args: PhaseArguments) => createHarness({
  provider: args.provider,
  model: args.model,
  workspace: args.workspace,
  stateDirectory: args.stateDirectory,
  maxSteps: 4,
  // This matrix preserves the 0.4 single-agent certification contract. The
  // 0.5 orchestration matrix is tracked separately so delegation cannot make
  // this smoke pass without exercising the exact reviewed-edit path.
  subagentProfiles: [],
  env: process.env
});

const requestPhase = async (args: PhaseArguments): Promise<RequestPhaseOutput> => {
  const harness = await createLiveHarness(args);
  try {
    const expected = expectedApprovalArguments(args.provider);
    const result = await runHarness(harness, {
      ...providerRunInput(args.provider, certificationPrompt(args.provider)),
      scope: harness.config.scope,
      idempotencyKey: `live-certification-${args.provider}`
    });
    throwTransientRunFailure(result);

    assert.equal(
      result.status,
      "waiting_approval",
      `Expected approval wait, got ${result.status}; output=${JSON.stringify(result.outputText)}; ` +
        `finish=${JSON.stringify(result.finishReason)}; providerFinish=${JSON.stringify(result.providerFinishReason)}; ` +
        `steps=${result.steps.length}; ` +
        `tools=${JSON.stringify(result.toolResults.map((toolResult) => ({
          name: toolResult.toolName,
          isError: toolResult.isError,
          error: toolResult.error?.message
        })))}; error=${JSON.stringify(result.error?.message)}`
    );
    const approval = result.state.pendingApprovals.find((candidate) => candidate.name === "apply_patch");
    assert.ok(approval, "The provider did not request the apply_patch approval.");
    assert.equal(approval.kind, "local-tool");
    assert.deepEqual(JSON.parse(approval.arguments), expected);
    assert.equal(result.state.pendingApprovals.length, 1);
    await assert.rejects(readFile(path.join(args.workspace, certificationPath(args.provider)), "utf8"));

    const persisted = await harness.store.load(result.state.runId, harness.config.scope);
    assert.equal(persisted?.status, "waiting_approval");
    assert.equal(persisted?.pendingApprovals[0]?.id, approval.id);
    return {
      phase: "request",
      provider: args.provider,
      model: args.model,
      runId: result.state.runId,
      approvalId: approval.id
    };
  } finally {
    await harness.close();
  }
};

const resumePhase = async (args: PhaseArguments): Promise<ResumePhaseOutput> => {
  assert.ok(args.runId);
  const harness = await createLiveHarness(args);
  try {
    const state = await harness.store.load(args.runId, harness.config.scope);
    assert.equal(state?.status, "waiting_approval");
    const approval = state.pendingApprovals.find((candidate) => candidate.name === "apply_patch");
    assert.ok(approval, "The persisted run has no apply_patch approval.");
    assert.deepEqual(JSON.parse(approval.arguments), expectedApprovalArguments(args.provider));

    const result = await runHarness(harness, {
      state,
      ...liveProviderOptions(args.provider),
      approvals: [{
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true,
        reason: "Opt-in live provider certification."
      }]
    });
    throwTransientRunFailure(result);

    assert.equal(result.status, "completed", result.outputText || result.error?.message);
    assert.ok(result.outputText.includes(completionToken(args.provider)), result.outputText);
    const writeResults = result.toolResults.filter((toolResult) => toolResult.toolName === "apply_patch");
    assert.equal(writeResults.length, 1);
    assert.equal(writeResults[0]?.isError, false);
    assert.equal(
      await readFile(path.join(args.workspace, certificationPath(args.provider)), "utf8"),
      certificationContent(args.provider)
    );

    const journal = await harness.store.listToolCalls?.(args.runId, harness.config.scope);
    const writeEntries = journal?.filter((entry) => entry.toolName === "apply_patch") ?? [];
    assert.equal(writeEntries.length, 1);
    assert.equal(writeEntries[0]?.status, "completed");
    return {
      phase: "resume",
      provider: args.provider,
      model: args.model,
      runId: args.runId,
      toolExecutions: writeResults.length,
      journalEntries: writeEntries.length
    };
  } finally {
    await harness.close();
  }
};

const executePhase = async (args: PhaseArguments): Promise<PhaseOutput> =>
  args.phase === "request" ? requestPhase(args) : resumePhase(args);

const runChild = async (args: string[], env: NodeJS.ProcessEnv): Promise<PhaseOutput> => {
  const child = Bun.spawn([process.execPath, import.meta.path, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...env, [CHILD_MARKER]: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, PHASE_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    if (timedOut) {
      throw new Error(`Live child exceeded ${PHASE_TIMEOUT_MS}ms.`);
    }
    if (exitCode !== 0) {
      const diagnostic = redacted(stderr.trim() || stdout.trim() || `Live child exited ${exitCode}.`, env);
      try {
        const parsed = JSON.parse(diagnostic) as { error?: unknown };
        if (parsed.error !== undefined) throw restoreSanitizedOperationalError(parsed.error);
      } catch (error) {
        if (error instanceof Error && error.name !== "SyntaxError") {
          throw error;
        }
      }
      throw new Error(diagnostic);
    }
    return JSON.parse(stdout) as PhaseOutput;
  } finally {
    clearTimeout(timeout);
  }
};

const orchestrate = async (env: NodeJS.ProcessEnv) => {
  assertLiveOptIn(env);
  const providers = selectedProviders(env);

  const evidence: Array<
    | (ResumePhaseOutput & { ok: true })
    | {
        ok: false;
        provider: HarnessProvider;
        model: string;
        error: Record<string, unknown>;
      }
  > = [];
  for (const provider of providers) {
    const model = env[modelEnvironmentName(provider)]?.trim() || providerDescriptor(provider).defaultModel;
    if (!providerHasCredentials(provider, env)) {
      evidence.push({ ok: false, provider, model, error: providerCredentialFailure(provider) });
      continue;
    }
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      const workspace = await mkdtemp(path.join(os.tmpdir(), `zhivex-harness-live-${provider}-`));
      const stateDirectory = path.join(workspace, ".zhivex-harness", "runs");
      try {
        const request = await runChild([
          "--phase", "request",
          "--provider", provider,
          "--model", model,
          "--workspace", workspace,
          "--state-dir", stateDirectory
        ], env);
        assert.equal(request.phase, "request");
        assert.equal(request.provider, provider);
        await assert.rejects(readFile(path.join(workspace, certificationPath(provider)), "utf8"));

        const resumed = await runChild([
          "--phase", "resume",
          "--provider", provider,
          "--model", model,
          "--workspace", workspace,
          "--state-dir", stateDirectory,
          "--run-id", request.runId
        ], env);
        assert.equal(resumed.phase, "resume");
        assert.equal(resumed.provider, provider);
        assert.equal(resumed.toolExecutions, 1);
        assert.equal(resumed.journalEntries, 1);
        assert.equal(await readFile(path.join(workspace, certificationPath(provider)), "utf8"), certificationContent(provider));
        evidence.push({ ...resumed, ok: true });
        break;
      } catch (error) {
        if (attempt < MAX_TRANSIENT_ATTEMPTS && isTransientProviderFailure(error)) {
          await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS * attempt));
          continue;
        }
        const failure = JSON.parse(errorEvidence(error, env)) as {
          error: Record<string, unknown>;
        };
        evidence.push({ ok: false, provider, model, error: failure.error });
        break;
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
  const ok = evidence.every((entry) => entry.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    gate: "live-provider-smoke",
    certifiedAt: new Date().toISOString(),
    providers: evidence.map((entry) => entry.ok
      ? {
          ok: true,
          provider: entry.provider,
          model: entry.model,
          approvalPersisted: true,
          processRestarted: true,
          toolExecutions: entry.toolExecutions,
          journalEntries: entry.journalEntries
        }
      : entry)
  }, null, 2)}\n`);
  if (!ok) {
    process.exitCode = 1;
  }
};

const errorEvidence = (
  error: unknown,
  env: NodeJS.ProcessEnv,
  gate = "live-provider-smoke"
) => {
  void env;
  const evidence = {
    ok: false,
    gate,
    error: sanitizeOperationalError(error)
  };
  return JSON.stringify(evidence, null, 2);
};

export const liveProviderSmokeInternals = {
  assertLiveOptIn,
  certificationPrompt,
  errorEvidence,
  isTransientProviderFailure,
  parsePhaseArguments,
  providerCredentialFailure,
  providerHasCredentials,
  providerRunInput,
  redacted,
  requireCredentials,
  selectedProviders,
  throwTransientRunFailure
};

if (import.meta.main) {
  const phaseArguments = parsePhaseArguments(process.argv.slice(2));
  const run = phaseArguments
    ? async () => {
        if (process.env[CHILD_MARKER] !== "1") {
          throw new Error("Live child phases may only be started by the smoke orchestrator.");
        }
        process.stdout.write(`${JSON.stringify(await executePhase(phaseArguments))}\n`);
      }
    : () => orchestrate(process.env);

  run().catch((error: unknown) => {
    process.stderr.write(`${errorEvidence(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
