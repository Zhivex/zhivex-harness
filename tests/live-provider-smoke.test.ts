import { describe, expect, test } from "bun:test";

import { liveProviderSmokeInternals } from "../scripts/live-provider-smoke.js";
import { liveOrchestrationSmokeInternals, reviewDelegationContract } from "../scripts/live-orchestration-smoke.js";
import { liveExecutionSmokeInternals } from "../scripts/live-execution-smoke.js";
import { LIVE_ROUTING_DEFAULTS } from "../scripts/live-routing-smoke.js";

const {
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
} = liveProviderSmokeInternals;

describe("live provider smoke contract", () => {
  test("fails closed unless live network use is explicitly enabled", () => {
    expect(() => assertLiveOptIn({})).toThrow("ZHIVEX_HARNESS_LIVE=1");
    expect(() => assertLiveOptIn({ ZHIVEX_HARNESS_LIVE: "true" })).toThrow("ZHIVEX_HARNESS_LIVE=1");
    expect(() => assertLiveOptIn({ ZHIVEX_HARNESS_LIVE: "1" })).not.toThrow();
  });

  test("defaults to the complete provider matrix and validates subsets", () => {
    expect(selectedProviders({})).toEqual(["meta", "qwen", "openai"]);
    expect(selectedProviders({ ZHIVEX_HARNESS_LIVE_PROVIDERS: "gemini" })).toEqual(["gemini"]);
    expect(selectedProviders({ ZHIVEX_HARNESS_LIVE_PROVIDERS: "openai, qwen,openai" })).toEqual([
      "openai",
      "qwen"
    ]);
    expect(() => selectedProviders({ ZHIVEX_HARNESS_LIVE_PROVIDERS: "unknown" })).toThrow(
      "Unknown provider"
    );
  });

  test("requires credentials by name without exposing credential values", () => {
    expect(() => requireCredentials(["meta", "qwen", "openai", "gemini"], {
      MODEL_API_KEY: "meta-secret",
      DASHSCOPE_API_KEY: "qwen-secret"
    })).toThrow("openai");
    expect(() => requireCredentials(["meta", "qwen", "openai", "gemini"], {
      MODEL_API_KEY: "meta-secret",
      DASHSCOPE_API_KEY: "qwen-secret",
      OPENAI_API_KEY: "openai-secret",
      GEMINI_API_KEY: "gemini-secret"
    })).not.toThrow();
  });

  test("records a missing credential per provider without blocking the rest of the cohort", () => {
    const env = {
      MODEL_API_KEY: "meta-secret",
      OPENAI_API_KEY: "openai-secret"
    };
    expect(providerHasCredentials("meta", env)).toBe(true);
    expect(providerHasCredentials("qwen", env)).toBe(false);
    expect(providerHasCredentials("openai", env)).toBe(true);
    expect(providerCredentialFailure("qwen")).toMatchObject({
      code: "CONFIG_INVALID",
      category: "configuration",
      retryable: false
    });
  });

  test("projects structured errors without messages, payloads, or stacks", () => {
    const env = {
      OPENAI_API_KEY: "live-super-secret",
      OPENAI_BASE_URL: "https://private-endpoint.example/v1"
    };
    expect(redacted("before live-super-secret https://private-endpoint.example/v1 after", env)).toBe(
      "before [REDACTED] [REDACTED] after"
    );

    const error = Object.assign(new Error("raw model output live-super-secret"), {
      status: 503,
      responseBody: { output: "raw provider payload" }
    });
    const evidence = errorEvidence(error, env);
    const parsed = JSON.parse(evidence) as {
      gate: string;
      error: Record<string, unknown>;
    };
    expect(parsed).toMatchObject({
      gate: "live-provider-smoke",
      error: {
        code: "PROVIDER_UNAVAILABLE",
        category: "provider",
        retryable: true,
        status: 503
      }
    });
    expect(parsed.error.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence).not.toContain("live-super-secret");
    expect(evidence).not.toContain("raw model output");
    expect(evidence).not.toContain("raw provider payload");
    expect(parsed.error).not.toHaveProperty("message");
    expect(parsed.error).not.toHaveProperty("responseBody");
    expect(parsed.error).not.toHaveProperty("stack");
  });

  test("retries only bounded transient provider failures", () => {
    expect(isTransientProviderFailure(Object.assign(new Error("busy"), { status: 503 }))).toBe(true);
    expect(isTransientProviderFailure(Object.assign(new Error("limited"), { statusCode: 429 }))).toBe(true);
    expect(isTransientProviderFailure(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
    expect(isTransientProviderFailure(new Error("contract failure"))).toBe(false);
  });

  test("preserves transient status returned in a failed run before contract assertions", () => {
    const returnedFailure = {
      status: "failed",
      error: { message: "Provider request failed with HTTP 503 Service Unavailable." }
    };
    let propagated: unknown;
    try {
      throwTransientRunFailure(returnedFailure);
    } catch (error) {
      propagated = error;
    }

    expect(propagated).toBeInstanceOf(Error);
    expect((propagated as { status?: unknown }).status).toBe(503);
    expect(isTransientProviderFailure(propagated)).toBe(true);
    expect(() => throwTransientRunFailure({
      status: "failed",
      error: { message: "Provider request failed with HTTP 400 Bad Request." }
    })).not.toThrow();
  });

  test("accepts only complete orchestrator-owned child phase arguments", () => {
    expect(parsePhaseArguments([])).toBeUndefined();
    expect(parsePhaseArguments([
      "--phase", "request",
      "--provider", "qwen",
      "--model", "qwen3.8-max",
      "--workspace", "/tmp/workspace",
      "--state-dir", "/tmp/workspace/.zhivex-harness/runs"
    ])).toMatchObject({ phase: "request", provider: "qwen", model: "qwen3.8-max" });
    expect(() => parsePhaseArguments([
      "--phase", "resume",
      "--provider", "qwen",
      "--model", "qwen3.8-max",
      "--workspace", "/tmp/workspace",
      "--state-dir", "/tmp/workspace/.zhivex-harness/runs"
    ])).toThrow("runId");
  });

  test("certifies the proposal before requesting approval to apply it", () => {
    const prompt = certificationPrompt("meta");
    expect(prompt).toContain("Call propose_edits exactly once");
    expect(prompt).toContain("then call apply_patch exactly once");
    expect(prompt).toContain("Keep it present with the explicit JSON value null");
    expect(prompt).toContain("Calling apply_patch is how you request operator approval");
    expect(prompt).toContain("Do not ask for approval in text");
    expect(prompt.indexOf("propose_edits")).toBeLessThan(prompt.indexOf("apply_patch"));

    const input = providerRunInput("meta", prompt);
    expect(input.toolChoice).toBe("auto");
    expect(input.providerOptions).toBeUndefined();
    expect(providerRunInput("qwen", prompt).providerOptions).toEqual({ apiMode: "responses" });
    expect(providerRunInput("openai", prompt).providerOptions).toEqual({ apiMode: "responses" });
    expect(providerRunInput("gemini", prompt).providerOptions).toBeUndefined();
  });

  test("requires one exact bounded reviewer delegation for orchestration certification", () => {
    const prompt = liveOrchestrationSmokeInternals.orchestrationPrompt("openai");
    expect(prompt).toContain("Call delegate_reviewer exactly once");
    expect(prompt).toContain("Do not call any other tool");
    expect(prompt).toContain(JSON.stringify({ taskId: "release-review" }));
    expect(reviewDelegationContract("openai")).toMatchObject({
      profile: "reviewer", allowedReadPaths: ["review-target.txt"],
      prompt: liveOrchestrationSmokeInternals.childPrompt("openai"),
      requiredOutput: "ZHIVEX_HARNESS_OPENAI_CHILD_OK"
    });
    expect(liveOrchestrationSmokeInternals.childPrompt("openai")).toContain("Review review-target.txt");
    expect(liveOrchestrationSmokeInternals.childPrompt("openai")).toContain("at most one read-only repository tool");
    expect(prompt).toContain(liveOrchestrationSmokeInternals.parentToken("openai"));
  });

  test("requires the command, review, and separate import sequence for execution certification", () => {
    const prompt = liveExecutionSmokeInternals.executionPrompt("qwen");
    const command = liveExecutionSmokeInternals.executionCommandInput("qwen");
    expect(command.command).toBe("node");
    expect(command.args).toEqual(["live-execution-fixture.mjs"]);
    expect(command.args).not.toContain("-e");
    expect(prompt).toContain(JSON.stringify(command));
    expect(prompt.indexOf("run_environment_command")).toBeLessThan(
      prompt.indexOf("inspect_environment_patch")
    );
    expect(prompt.indexOf("inspect_environment_patch")).toBeLessThan(
      prompt.indexOf("apply_environment_patch")
    );
    expect(prompt).toContain(liveExecutionSmokeInternals.completionToken("qwen"));
  });

  test("rejects command argument mismatches while exposing only bounded structural evidence", () => {
    const expected = liveExecutionSmokeInternals.executionCommandInput("qwen");
    const cases = [
      {
        label: "command value",
        actual: { ...expected, command: "PRIVATE_COMMAND /private/home/secret" },
        expectedDiagnostic: { commandMatchesExpected: false }
      },
      {
        label: "argv content",
        actual: { ...expected, args: [...expected.args.slice(0, 0), "PRIVATE_SCRIPT /private/source"] },
        expectedDiagnostic: { argumentMismatches: [{ index: 0, actualType: "string", matchesExpected: false }] }
      },
      {
        label: "argv count",
        actual: { ...expected, args: expected.args.slice(0, 0) },
        expectedDiagnostic: {
          actualArgCount: 0,
          extraArgCount: 0,
          argumentMismatches: [{ index: 0, actualType: "undefined", matchesExpected: false }]
        }
      },
      {
        label: "argv type",
        actual: { ...expected, args: "PRIVATE_ARGUMENTS" },
        expectedDiagnostic: { argsType: "string" }
      },
      {
        label: "nested argv value",
        actual: { ...expected, args: [...expected.args.slice(0, 0), { PRIVATE_FIELD: "PRIVATE_NESTED_VALUE" }] },
        expectedDiagnostic: {
          argumentMismatches: [{ index: 0, actualType: "object", matchesExpected: false, nestedMemberCount: 1 }]
        }
      },
      {
        label: "extra root field",
        actual: { ...expected, PRIVATE_FIELD: "PRIVATE_EXTRA_VALUE" },
        expectedDiagnostic: { extraFieldCount: 1 }
      },
      {
        label: "extra argv item",
        actual: { ...expected, args: [...expected.args, "PRIVATE_EXTRA_ARG"] },
        expectedDiagnostic: { actualArgCount: 2, extraArgCount: 1 }
      },
      {
        label: "root shape",
        actual: ["PRIVATE_ROOT_VALUE"],
        expectedDiagnostic: { rootType: "array", commandPresent: false, argsPresent: false }
      }
    ] as const;

    for (const mismatch of cases) {
      let failure: unknown;
      try {
        liveExecutionSmokeInternals.assertExecutionCommandArguments(mismatch.actual, "qwen");
      } catch (error) {
        failure = error;
      }
      expect(failure, mismatch.label).toBeInstanceOf(Error);
      const diagnostic = liveExecutionSmokeInternals.executionArgumentsDiagnostic(
        mismatch.actual,
        expected
      );
      expect(diagnostic, mismatch.label).toMatchObject(mismatch.expectedDiagnostic);
      const serialized = JSON.stringify(diagnostic);
      expect(serialized, mismatch.label).not.toContain("PRIVATE_");
      expect(serialized, mismatch.label).not.toContain("/private/");
    }

    expect(() => liveExecutionSmokeInternals.assertExecutionCommandArguments(expected, "qwen")).not.toThrow();
  });

  test("keeps the default mixed route inside the certified provider cohort", () => {
    expect(LIVE_ROUTING_DEFAULTS).toEqual({ parent: "openai", reviewer: "qwen" });
  });
});

test("execution gate preserves message-only provider status without retaining private payloads", () => {
  let failure: unknown;
  try { liveExecutionSmokeInternals.assertExecutionRunStatus({ status: "failed",
    error: { message: "Provider request failed with HTTP 503 PRIVATE_PROVIDER_PAYLOAD" } }); }
  catch (error) { failure = error; }
  expect((failure as { status?: number }).status).toBe(503);
  const safe = JSON.parse(errorEvidence(failure, {}));
  expect(safe.error.details.chain.some((entry: { status?: number }) => entry.status === 503)).toBe(true);
  expect(JSON.stringify(safe)).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
  expect(() => liveExecutionSmokeInternals.assertExecutionRunStatus({ status: "completed", outputText: "done" })).not.toThrow();
  expect(() => liveExecutionSmokeInternals.assertExecutionRunStatus({ status: "waiting_approval" })).toThrow();
});

test('structured delegation certification is opt-in and requires durable accepted evidence',async()=>{
  const {reviewDelegationContract,assertStructuredDelegationEvidence}=await import('../scripts/live-orchestration-smoke.js');
  expect(reviewDelegationContract('anthropic').resultContract).toBeUndefined();
  expect(reviewDelegationContract('anthropic',true).resultContract).toEqual({schemaVersion:1,requiredReadPaths:['review-target.txt'],humanReviewRequired:true,maxCorrections:1});
  const evaluation={taskId:'release-review',childRunId:'child',childStatus:'completed',accepted:true,semanticReview:'pending',correctionsUsed:1};
  expect(()=>assertStructuredDelegationEvidence({schemaVersion:1,evaluations:[evaluation]},'child')).not.toThrow();
  for(const change of [{accepted:false},{childRunId:'another'},{childStatus:'failed'},{semanticReview:'verified'},{correctionsUsed:2}]) {
    expect(()=>assertStructuredDelegationEvidence({schemaVersion:1,evaluations:[{...evaluation,...change}]},'child')).toThrow();
  }
  expect(()=>assertStructuredDelegationEvidence(undefined,'child')).toThrow();
});

 test('Vertex live preflight accepts explicit route configuration without pretending ADC is validated',()=>{
  expect(providerHasCredentials('vertex',{})).toBe(false);
  expect(providerHasCredentials('vertex',{GOOGLE_CLOUD_PROJECT:'fixture-project',VERTEX_LOCATION:'global'})).toBe(true);
  expect(providerHasCredentials('vertex',{GOOGLE_CLOUD_PROJECT:'invalid/path',VERTEX_LOCATION:'global'})).toBe(false);
  expect(providerHasCredentials('anthropic',{})).toBe(false);
  expect(providerHasCredentials('anthropic',{ANTHROPIC_API_KEY:'fixture-only'})).toBe(true);
 });
 test('live error redaction excludes Vertex routing identifiers and ADC paths',()=>{
  const env={GOOGLE_CLOUD_PROJECT:'private-project',VERTEX_LOCATION:'private-location',GOOGLE_APPLICATION_CREDENTIALS:'/private/adc.json',ANTHROPIC_BASE_URL:'https://private.endpoint'};
  expect(redacted(Object.values(env).join(' '),env)).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
 });

test('approval continuation evidence isolates the approved call and preserves private state exactly',async()=>{
  const {approvalContinuation}=await import('../scripts/live-provider-smoke.js');
  const messages: import('@zhivex-ai/core').ModelMessage[]=[{role:'assistant',parts:[
    {type:'provider-data',provider:'anthropic',data:{type:'thinking',signature:'fixture-signature'}},
    {type:'tool-call',toolCall:{id:'approved',name:'apply_patch',input:{},providerMetadata:{geminiThoughtSignature:'fixture-google'}}}
  ]}];
  const snapshot=approvalContinuation(messages,'approved');
  expect(snapshot).toEqual({metadata:{geminiThoughtSignature:'fixture-google'},privateParts:[{type:'provider-data',provider:'anthropic',data:{type:'thinking',signature:'fixture-signature'}}]});
  expect(()=>approvalContinuation(messages,'absent')).toThrow('Approved call must survive');
  (messages[0]!.parts[0] as {data:unknown}).data={type:'thinking',signature:'mutated'};
  expect(snapshot.privateParts[0]).toMatchObject({data:{signature:'fixture-signature'}});
  expect(approvalContinuation(messages,'approved')).not.toEqual(snapshot);
});

test("Qwen contract certification pins zero sampling temperature without changing other routes", () => {
  expect(providerRunInput("qwen", "fixture")).toMatchObject({temperature:0,providerOptions:{apiMode:"responses"},maxSteps:4});
  expect(providerRunInput("openai", "fixture")).not.toHaveProperty("temperature");
  expect(providerRunInput("anthropic", "fixture")).not.toHaveProperty("temperature");
});
