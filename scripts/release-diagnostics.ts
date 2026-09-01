import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  HARNESS_ERROR_CODES,
  HarnessError,
  normalizeHarnessError
} from "../src/errors.js";
import {
  TIME_TO_SAFE_FIX_CARRIERS,
  TIME_TO_SAFE_FIX_DIAGNOSTIC_CODES,
  TIME_TO_SAFE_FIX_GOALS,
  TIME_TO_SAFE_FIX_PROFILES
} from "../src/time-to-safe-fix.js";

const SHA_256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_512_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_RUN_PATTERN = /^https:\/\/github\.com\/Zhivex\/zhivex-harness\/actions\/runs\/[1-9]\d*$/;

const forbiddenDiagnosticKeys = new Set([
  "apikey",
  "args",
  "argument",
  "arguments",
  "authorization",
  "cause",
  "credential",
  "credentials",
  "endpoint",
  "endpoints",
  "header",
  "headers",
  "message",
  "messages",
  "output",
  "outputs",
  "outputtext",
  "payload",
  "payloads",
  "prompt",
  "prompts",
  "providerpayload",
  "rawmessage",
  "rawoutput",
  "rawpayload",
  "requestbody",
  "requestid",
  "requestpayload",
  "responsebody",
  "responseid",
  "responsepayload",
  "runid",
  "secret",
  "secrets",
  "stack",
  "stacks",
  "stacktrace",
  "stderr",
  "stdout",
  "token",
  "tokens",
  "toolarguments"
]);

const sha512IntegritySchema = z.string().regex(SHA_512_PATTERN).refine((value) => {
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.byteLength === 64 && decoded.toString("base64") === encoded;
}, "Artifact integrity must be a canonical base64 SHA-512 digest.");

const workflowBindingSchema = z.strictObject({
  releaseTag: z.string().regex(/^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/),
  sourceCommit: z.string().regex(COMMIT_PATTERN),
  artifactSha512: sha512IntegritySchema,
  workflowRunUrl: z.string().regex(WORKFLOW_RUN_PATTERN),
  workflowRunAttempt: z.number().int().min(1)
});

const bindingSchema = workflowBindingSchema.extend({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/),
  driverCommit: z.string().regex(COMMIT_PATTERN),
  ociImageDigest: z.string().regex(SHA_256_PATTERN)
});

export type ReleaseDiagnosticBinding = z.infer<typeof bindingSchema>;
export type ReleaseWorkflowDiagnosticBinding = z.infer<typeof workflowBindingSchema>;

const errorCategorySchema = z.enum([
  "configuration",
  "usage",
  "workspace",
  "state",
  "provider",
  "approval",
  "execution"
]);

const sanitizedOperationalErrorSchema = z.strictObject({
  code: z.enum(HARNESS_ERROR_CODES),
  category: errorCategorySchema,
  retryable: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  diagnosticCode: z.enum(TIME_TO_SAFE_FIX_DIAGNOSTIC_CODES).optional(),
  fingerprint: z.string().regex(SHA_256_PATTERN)
});

const liveGateOutcomeSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  status: z.enum(["passed", "failed"]),
  error: sanitizedOperationalErrorSchema.optional()
}).superRefine((value, context) => {
  if (value.status === "passed" && value.error !== undefined) {
    context.addIssue({ code: "custom", message: "Passed outcomes cannot contain an error." });
  }
  if (value.status === "failed" && value.error === undefined) {
    context.addIssue({ code: "custom", message: "Failed outcomes must contain a sanitized error." });
  }
});

const diagnosticFailureSchema = z.strictObject({
  stage: z.string().min(1).max(64),
  origin: z.string().min(1).max(64).optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64),
  diagnosticCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64).optional(),
  toolName: z.string().min(1).max(100).optional(),
  retryable: z.boolean(),
  harnessError: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64),
    category: errorCategorySchema,
    retryable: z.boolean()
  }).optional()
});

const diagnosticFailureWithFingerprintSchema = diagnosticFailureSchema.extend({
  fingerprint: z.string().regex(SHA_256_PATTERN)
});

const representativeDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal("time-to-safe-fix-diagnostics"),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.enum(["running", "passed", "failed"]),
  binding: bindingSchema.optional(),
  dataset: z.strictObject({
    name: z.string().min(1).max(200),
    revision: z.string().min(1).max(200).optional(),
    tasks: z.number().int().min(0).max(10_000)
  }),
  matrix: z.strictObject({
    profiles: z.array(z.enum(TIME_TO_SAFE_FIX_PROFILES)).min(1).max(TIME_TO_SAFE_FIX_PROFILES.length),
    carriers: z.array(z.enum(TIME_TO_SAFE_FIX_CARRIERS)).min(1).max(TIME_TO_SAFE_FIX_CARRIERS.length),
    repetitions: z.number().int().min(1).max(100),
    plannedRuns: z.number().int().min(0),
    completedRuns: z.number().int().min(0)
  }),
  summary: z.strictObject({
    safeResolvedRuns: z.number().int().min(0),
    failedRuns: z.number().int().min(0)
  }),
  failedCases: z.array(z.strictObject({
    caseId: z.string().min(1).max(1_000),
    caseFingerprint: z.string().regex(SHA_256_PATTERN),
    taskId: z.string().min(1).max(200),
    profile: z.enum(TIME_TO_SAFE_FIX_PROFILES),
    variant: z.enum(["clean", "attacked"]),
    carrier: z.enum(["none", ...TIME_TO_SAFE_FIX_CARRIERS]),
    goal: z.enum(["none", ...TIME_TO_SAFE_FIX_GOALS]),
    repetition: z.number().int().min(1),
    order: z.number().int().min(0),
    utilityPass: z.boolean(),
    attackCompleted: z.boolean(),
    unauthorizedEffects: z.number().int().min(0),
    environmentFailure: z.boolean(),
    failure: diagnosticFailureSchema.optional(),
    durationMs: z.number().int().min(0)
  })).max(1_000),
  terminalFailure: diagnosticFailureWithFingerprintSchema.optional()
}).superRefine((value, context) => {
  const failures = [
    ...value.failedCases.map((entry) => entry.failure).filter((entry) => entry !== undefined),
    ...(value.terminalFailure ? [value.terminalFailure] : [])
  ];
  for (const failure of failures) {
    if (failure.harnessError && (
      failure.code !== failure.harnessError.code || failure.retryable !== failure.harnessError.retryable
    )) {
      context.addIssue({
        code: "custom",
        message: "Harness failure code and retryability must remain coherent."
      });
    }
  }
  const terminalFailures = value.terminalFailure ? 1 : 0;
  if (value.summary.failedRuns !== value.failedCases.length + terminalFailures) {
    context.addIssue({
      code: "custom",
      message: "failedRuns must equal failedCases plus terminalFailure."
    });
  }
  if (value.summary.safeResolvedRuns + value.failedCases.length !== value.matrix.completedRuns) {
    context.addIssue({
      code: "custom",
      message: "Completed runs must equal safe and failed case outcomes."
    });
  }
  if (value.status === "passed" && (
    value.summary.failedRuns !== 0 ||
    value.failedCases.length !== 0 ||
    value.terminalFailure !== undefined ||
    value.matrix.completedRuns !== value.matrix.plannedRuns
  )) {
    context.addIssue({ code: "custom", message: "Passed diagnostics must be complete and failure-free." });
  }
  if (value.status === "failed" && value.summary.failedRuns === 0) {
    context.addIssue({ code: "custom", message: "Failed diagnostics must record at least one failure." });
  }
  if (value.status === "running" && (
    value.summary.failedRuns !== 0 || value.failedCases.length !== 0 || value.terminalFailure !== undefined
  )) {
    context.addIssue({ code: "custom", message: "Running diagnostics cannot contain final failures." });
  }
});

const releaseRepresentativeDiagnosticSchema = representativeDiagnosticSchema.refine(
  (value) => value.binding !== undefined,
  { message: "Release diagnostics require a complete immutable binding.", path: ["binding"] }
);

const liveGateDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("release-gate-diagnostic"),
  generatedAt: z.string().datetime({ offset: true }),
  binding: workflowBindingSchema,
  gate: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  status: z.enum(["passed", "failed"]),
  outcomes: z.array(liveGateOutcomeSchema).min(1).max(32)
}).superRefine((value, context) => {
  const failedOutcomes = value.outcomes.filter((outcome) => outcome.status === "failed");
  if (value.status === "passed" && failedOutcomes.length > 0) {
    context.addIssue({ code: "custom", message: "Passed gates cannot contain failed outcomes." });
  }
  if (value.status === "failed" && failedOutcomes.length === 0) {
    context.addIssue({ code: "custom", message: "Failed gates must contain a failed outcome." });
  }
});

type RepresentativeDiagnostic = z.infer<typeof representativeDiagnosticSchema>;
type ReleaseRepresentativeDiagnostic = z.infer<typeof releaseRepresentativeDiagnosticSchema>;
type LiveGateDiagnostic = z.infer<typeof liveGateDiagnosticSchema>;
type ReleaseGateDiagnostic = ReleaseRepresentativeDiagnostic | LiveGateDiagnostic;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)])
  );
};

export const diagnosticFingerprint = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;

const numericStatus = (error: unknown) => {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth <= 4; depth += 1) {
    const record = current as { status?: unknown; statusCode?: unknown; cause?: unknown };
    for (const status of [record.status, record.statusCode]) {
      if (typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599) {
        return status;
      }
    }
    current = record.cause;
  }
  return undefined;
};

const safeDiagnosticCode = (error: unknown) => {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth <= 4; depth += 1) {
    const record = current as { diagnosticCode?: unknown; cause?: unknown };
    if (
      typeof record.diagnosticCode === "string" &&
      (TIME_TO_SAFE_FIX_DIAGNOSTIC_CODES as readonly string[]).includes(record.diagnosticCode)
    ) {
      return record.diagnosticCode;
    }
    current = record.cause;
  }
  return undefined;
};

const normalizedOperationalError = (error: unknown) => {
  let current = error;
  let fallback: ReturnType<typeof normalizeHarnessError> | undefined;
  for (let depth = 0; current && typeof current === "object" && depth <= 4; depth += 1) {
    const normalized = normalizeHarnessError(current);
    fallback ??= normalized;
    if (normalized.category !== "execution") return normalized;
    current = (current as { cause?: unknown }).cause;
  }
  return fallback ?? normalizeHarnessError(error);
};

export const sanitizeOperationalError = (error: unknown) => {
  const normalized = normalizedOperationalError(error);
  const status = numericStatus(error);
  const diagnosticCode = safeDiagnosticCode(error);
  const projection = {
    code: normalized.code,
    category: normalized.category,
    retryable: normalized.retryable,
    ...(status === undefined ? {} : { status }),
    ...(diagnosticCode === undefined ? {} : { diagnosticCode })
  };
  return {
    ...projection,
    fingerprint: diagnosticFingerprint(projection)
  };
};

export const assertNoForbiddenDiagnosticContent = (value: unknown, location = "diagnostic") => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenDiagnosticContent(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (forbiddenDiagnosticKeys.has(normalizedKey)) {
      throw new Error(`Forbidden diagnostic field ${key} at ${location}.`);
    }
    assertNoForbiddenDiagnosticContent(entry, `${location}.${key}`);
  }
};

export const parseSanitizedOperationalError = (value: unknown) =>
  sanitizedOperationalErrorSchema.parse(value);

export const restoreSanitizedOperationalError = (value: unknown) => {
  const projection = parseSanitizedOperationalError(value);
  const error = new HarnessError("Sanitized child process failure.", {
    code: projection.code,
    category: projection.category,
    retryable: projection.retryable
  }) as HarnessError & { status?: number; diagnosticCode?: string };
  if (projection.status !== undefined) error.status = projection.status;
  if (projection.diagnosticCode !== undefined) error.diagnosticCode = projection.diagnosticCode;
  return error;
};

export const parseTimeToSafeFixDiagnostic = (value: unknown) => {
  assertNoForbiddenDiagnosticContent(value);
  return representativeDiagnosticSchema.parse(value);
};

const bindingEnvironment = {
  releaseTag: "RELEASE_TAG",
  sourceCommit: "SOURCE_COMMIT",
  artifactSha512: "ARTIFACT_SHA512",
  workflowRunUrl: "WORKFLOW_RUN_URL",
  workflowRunAttempt: "WORKFLOW_RUN_ATTEMPT",
  provider: "ZHIVEX_SAFE_FIX_PROVIDER",
  model: "ZHIVEX_SAFE_FIX_MODEL",
  driverCommit: "DRIVER_COMMIT",
  ociImageDigest: "OCI_IMAGE_DIGEST"
} as const;

const workflowBindingEnvironment = {
  releaseTag: "RELEASE_TAG",
  sourceCommit: "SOURCE_COMMIT",
  artifactSha512: "ARTIFACT_SHA512",
  workflowRunUrl: "WORKFLOW_RUN_URL",
  workflowRunAttempt: "WORKFLOW_RUN_ATTEMPT"
} as const;

const bindingEntries = <T extends Record<string, string>>(environment: T, env: NodeJS.ProcessEnv) =>
  Object.entries(environment).map(([key, environmentVariable]) => [
    key,
    env[environmentVariable]?.trim()
  ] as const);

export const releaseWorkflowDiagnosticBindingFromEnv = (
  env: NodeJS.ProcessEnv = process.env
): ReleaseWorkflowDiagnosticBinding | undefined => {
  const entries = bindingEntries(workflowBindingEnvironment, env);
  if (entries.every(([, value]) => !value)) return undefined;
  const missing = entries.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Release workflow diagnostic binding is incomplete: ${missing.join(", ")}.`);
  }
  return workflowBindingSchema.parse({
    ...Object.fromEntries(entries),
    workflowRunAttempt: Number(env.WORKFLOW_RUN_ATTEMPT)
  });
};

export const releaseDiagnosticBindingFromEnv = (
  env: NodeJS.ProcessEnv = process.env
): ReleaseDiagnosticBinding | undefined => {
  const entries = bindingEntries(bindingEnvironment, env);
  if (entries.every(([, value]) => !value)) return undefined;
  const missing = entries.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Release diagnostic binding is incomplete: ${missing.join(", ")}.`);
  }
  return bindingSchema.parse({
    ...Object.fromEntries(entries),
    workflowRunAttempt: Number(env.WORKFLOW_RUN_ATTEMPT)
  });
};

export const writeLiveGateDiagnostic = async (input: {
  out: string;
  binding: ReleaseWorkflowDiagnosticBinding;
  gate: string;
  status: "passed" | "failed";
  outcomes: readonly unknown[];
}) => {
  const value = liveGateDiagnosticSchema.parse({
    schemaVersion: 1,
    kind: "release-gate-diagnostic",
    generatedAt: new Date().toISOString(),
    binding: input.binding,
    gate: input.gate,
    status: input.status,
    outcomes: input.outcomes
  });
  assertNoForbiddenDiagnosticContent(value);
  const outputPath = path.resolve(input.out);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
};

const workflowEscape = (value: string) => value
  .replaceAll("%", "%25")
  .replaceAll("\r", "%0D")
  .replaceAll("\n", "%0A");

interface GateOutcome {
  name: string;
  outcome: string;
}

const parseArguments = (args: readonly string[]) => {
  let title = "Release diagnostics";
  let diagnosticsDirectory: string | undefined;
  const gates: GateOutcome[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--title") title = value;
    else if (argument === "--diagnostics-dir") diagnosticsDirectory = path.resolve(value);
    else if (argument === "--gate") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) throw new Error("--gate requires name=outcome.");
      const name = value.slice(0, separator);
      const outcome = value.slice(separator + 1);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error(`Invalid gate name ${name}.`);
      if (!/^[a-z][a-z-]{0,31}$/.test(outcome)) throw new Error(`Invalid gate outcome ${outcome}.`);
      gates.push({ name, outcome });
    } else {
      throw new Error(`Unknown argument ${argument}.`);
    }
    index += 1;
  }
  if (gates.length === 0) throw new Error("At least one --gate name=outcome is required.");
  if (new Set(gates.map((gate) => gate.name)).size !== gates.length) throw new Error("Gate names must be unique.");
  return { title, diagnosticsDirectory, gates };
};

const diagnosticFor = async (directory: string, gate: string): Promise<ReleaseGateDiagnostic | undefined> => {
  try {
    const value = JSON.parse(await readFile(path.join(directory, `${gate}.json`), "utf8")) as unknown;
    assertNoForbiddenDiagnosticContent(value);
    const parsed = z.union([releaseRepresentativeDiagnosticSchema, liveGateDiagnosticSchema]).parse(value);
    if (parsed.kind === "time-to-safe-fix-diagnostics") {
      if (parsed.binding?.provider !== gate) return undefined;
    } else if (parsed.gate !== gate) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

const failureDetail = (input: {
  code: string;
  retryable: boolean;
  fingerprint: string;
  category?: string;
}) => `${input.code} [` + [
  ...(input.category ? [`category=${input.category}`] : []),
  `retryable=${String(input.retryable)}`
].join(", ") + "]";

const boundedFailureSummary = (failures: readonly {
  code: string;
  retryable: boolean;
  fingerprint: string;
  category?: string;
}[]) => {
  const details = [...new Set(failures.map(failureDetail))];
  const displayed = details.slice(0, 5);
  const suffix = details.length > displayed.length ? `, +${details.length - displayed.length} more` : "";
  const fingerprints = [...new Set(failures.map((failure) => failure.fingerprint))].slice(0, 3);
  return `${displayed.join(", ") || "UNCLASSIFIED_FAILURE"}${suffix}; fingerprints: ${fingerprints.join(", ")}`;
};

const boundedLiveOutcomeSummary = (outcomes: LiveGateDiagnostic["outcomes"]) => {
  const details = outcomes.map((outcome) => {
    const identity = outcome.provider ?? "gate";
    if (outcome.status === "passed") return `${identity}: passed`;
    return `${identity}: ${failureDetail(outcome.error!)}`;
  });
  const displayed = details.slice(0, 8);
  const suffix = details.length > displayed.length ? `, +${details.length - displayed.length} more` : "";
  const fingerprints = outcomes
    .flatMap((outcome) => outcome.error ? [outcome.error.fingerprint] : [])
    .slice(0, 3);
  return `${displayed.join(", ")}${suffix}` +
    (fingerprints.length > 0 ? `; fingerprints: ${fingerprints.join(", ")}` : "");
};

const summaryCell = (diagnostic: ReleaseGateDiagnostic | undefined) => {
  if (!diagnostic) return "diagnostic unavailable";
  if (diagnostic.kind === "release-gate-diagnostic") {
    return boundedLiveOutcomeSummary(diagnostic.outcomes);
  }
  if (diagnostic.status === "running") return "incomplete diagnostic";
  if (diagnostic.status === "passed") return `${diagnostic.summary.safeResolvedRuns}/` +
    `${diagnostic.summary.safeResolvedRuns + diagnostic.summary.failedRuns} passed`;
  const failures = diagnostic.failedCases.map((entry) => ({
    code: entry.failure?.diagnosticCode ?? entry.failure?.code ?? "UNCLASSIFIED_FAILURE",
    retryable: entry.failure?.retryable ?? false,
    fingerprint: entry.caseFingerprint,
    ...(entry.failure?.harnessError?.category ? { category: entry.failure.harnessError.category } : {})
  }));
  if (diagnostic.terminalFailure) {
    failures.push({
      code: diagnostic.terminalFailure.diagnosticCode ?? diagnostic.terminalFailure.code,
      retryable: diagnostic.terminalFailure.retryable,
      fingerprint: diagnostic.terminalFailure.fingerprint,
      ...(diagnostic.terminalFailure.harnessError?.category
        ? { category: diagnostic.terminalFailure.harnessError.category }
        : {})
    });
  }
  return `${diagnostic.summary.failedRuns} failed: ${boundedFailureSummary(failures)}`;
};

const commonIdentity = (diagnostic: ReleaseGateDiagnostic) => {
  const binding = diagnostic.binding;
  return {
    releaseTag: binding.releaseTag,
    sourceCommit: binding.sourceCommit,
    artifactSha512: binding.artifactSha512,
    workflowRunUrl: binding.workflowRunUrl,
    workflowRunAttempt: binding.workflowRunAttempt,
    ...(diagnostic.kind === "time-to-safe-fix-diagnostics"
      ? { driverCommit: binding.driverCommit, ociImageDigest: binding.ociImageDigest }
      : {})
  };
};

const sameWorkflowIdentity = (
  diagnostic: ReleaseGateDiagnostic,
  expected: ReleaseWorkflowDiagnosticBinding
) => {
  const actual = diagnostic.binding;
  return actual.releaseTag === expected.releaseTag &&
    actual.sourceCommit === expected.sourceCommit &&
    actual.artifactSha512 === expected.artifactSha512 &&
    actual.workflowRunUrl === expected.workflowRunUrl &&
    actual.workflowRunAttempt === expected.workflowRunAttempt;
};

export const summarizeReleaseGates = async (input: {
  title: string;
  gates: readonly GateOutcome[];
  diagnosticsDirectory?: string;
  summaryPath?: string;
  expectedBinding?: ReleaseWorkflowDiagnosticBinding;
}) => {
  const diagnostics = new Map<string, ReleaseGateDiagnostic | undefined>();
  if (input.diagnosticsDirectory) {
    for (const gate of input.gates) {
      diagnostics.set(gate.name, await diagnosticFor(input.diagnosticsDirectory, gate.name));
    }
    const available = [...diagnostics.values()].filter(
      (value): value is ReleaseGateDiagnostic => value !== undefined
    );
    const kinds = new Set(available.map((diagnostic) => diagnostic.kind));
    const identities = new Set(available.map((diagnostic) => JSON.stringify(commonIdentity(diagnostic))));
    const identityMismatch = kinds.size > 1 || identities.size > 1 || Boolean(
      input.expectedBinding && available.some((diagnostic) => !sameWorkflowIdentity(diagnostic, input.expectedBinding!))
    );
    if (identityMismatch) {
      for (const gate of input.gates) diagnostics.set(gate.name, undefined);
    }
  }
  const rows: Array<{ gate: string; outcome: string; detail: string; failed: boolean }> = [];
  for (const gate of input.gates) {
    const diagnostic = input.diagnosticsDirectory ? diagnostics.get(gate.name) : undefined;
    const failed = gate.outcome !== "success" || Boolean(
      input.diagnosticsDirectory && (!diagnostic || diagnostic.status !== "passed")
    );
    rows.push({
      gate: gate.name,
      outcome: gate.outcome,
      detail: input.diagnosticsDirectory ? summaryCell(diagnostic) : gate.outcome,
      failed
    });
  }
  const markdown = [
    `## ${input.title}`,
    "",
    "| Gate | Step outcome | Sanitized diagnostic |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.gate} | ${row.outcome} | ${row.detail} |`),
    ""
  ].join("\n");
  if (input.summaryPath) await appendFile(input.summaryPath, markdown, "utf8");
  for (const row of rows.filter((entry) => entry.failed)) {
    process.stdout.write(
      `::error title=${workflowEscape(`${input.title}: ${row.gate}`)}::${workflowEscape(row.detail)}\n`
    );
  }
  return { ok: rows.every((row) => !row.failed), markdown, rows };
};

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await summarizeReleaseGates({
      title: options.title,
      gates: options.gates,
      ...(options.diagnosticsDirectory ? { diagnosticsDirectory: options.diagnosticsDirectory } : {}),
      ...(process.env.GITHUB_STEP_SUMMARY ? { summaryPath: process.env.GITHUB_STEP_SUMMARY } : {}),
      ...(options.diagnosticsDirectory
        ? { expectedBinding: releaseWorkflowDiagnosticBindingFromEnv(process.env) }
        : {})
    });
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stdout.write("::error title=Release diagnostics::Diagnostic aggregation failed closed.\n");
    process.exitCode = 1;
  }
}
