import { z } from "zod";

import { changeEnvelopeSchema } from "./change-envelope.js";
import { CLI_EVENT_SCHEMA_VERSION, CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import { PROVIDERS } from "./config.js";
import { HARNESS_ERROR_CODES, HARNESS_ERROR_SCHEMA_VERSION } from "./errors.js";

const observationalDocument = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();

const jsonBase = { schemaVersion: z.literal(CLI_JSON_SCHEMA_VERSION) };
const eventBase = {
  schemaVersion: z.literal(CLI_EVENT_SCHEMA_VERSION),
  sequence: z.number().int().nonnegative()
};
const nonnegativeInteger = z.number().int().nonnegative();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const jsonObjectSchema = observationalDocument({});
const scopeSchema = observationalDocument({
  tenantId: z.string().min(1),
  userId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional()
});
const runIdentity = {
  runId: z.string().min(1),
  status: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1)
};
const runSummarySchema = observationalDocument({
  ...runIdentity,
  revision: nonnegativeInteger,
  scope: scopeSchema,
  steps: nonnegativeInteger,
  toolCalls: nonnegativeInteger,
  toolErrors: nonnegativeInteger,
  pendingApprovals: nonnegativeInteger,
  compactions: nonnegativeInteger,
  childRuns: nonnegativeInteger,
  startedAt: nonnegativeInteger,
  updatedAt: nonnegativeInteger
});
const sessionRunSchema = observationalDocument({
  turnId: z.string().min(1),
  sequence: nonnegativeInteger,
  runId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.string().min(1),
  createdAt: nonnegativeInteger,
  updatedAt: nonnegativeInteger
});
const sessionSchema = observationalDocument({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  workspaceKey: z.string().min(1),
  scopeKey: z.string().min(1),
  revision: nonnegativeInteger,
  createdAt: nonnegativeInteger,
  updatedAt: nonnegativeInteger,
  runs: z.array(sessionRunSchema)
});
const tokenUsageSchema = observationalDocument({
  inputTokens: nonnegativeInteger.optional(),
  cachedInputTokens: nonnegativeInteger.optional(),
  cacheWriteTokens: nonnegativeInteger.optional(),
  outputTokens: nonnegativeInteger.optional(),
  reasoningTokens: nonnegativeInteger.optional(),
  totalTokens: nonnegativeInteger.optional(),
  speed: z.enum(["standard", "fast"]).optional()
});
const budgetConfigSchema = observationalDocument({
  maxSteps: nonnegativeInteger,
  maxToolCalls: nonnegativeInteger,
  maxToolErrors: nonnegativeInteger,
  maxInputTokens: nonnegativeInteger,
  maxOutputTokens: nonnegativeInteger,
  maxTotalTokens: nonnegativeInteger,
  includeChildRuns: z.boolean()
});
const budgetConsumptionSchema = observationalDocument({
  steps: nonnegativeInteger,
  toolCalls: nonnegativeInteger,
  toolErrors: nonnegativeInteger,
  inputTokens: nonnegativeInteger,
  outputTokens: nonnegativeInteger,
  totalTokens: nonnegativeInteger
});
const budgetRemainingSchema = observationalDocument({
  steps: nonnegativeInteger.optional(),
  toolCalls: nonnegativeInteger.optional(),
  toolErrors: nonnegativeInteger.optional(),
  inputTokens: nonnegativeInteger.optional(),
  outputTokens: nonnegativeInteger.optional(),
  totalTokens: nonnegativeInteger.optional()
});
const budgetStatusSchema = observationalDocument({
  consumption: budgetConsumptionSchema,
  remaining: budgetRemainingSchema,
  includeChildRuns: z.boolean()
});
const costEstimateSchema = observationalDocument({
  inputCost: z.number().nonnegative().optional(),
  outputCost: z.number().nonnegative().optional(),
  totalCost: z.number().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  usage: tokenUsageSchema.optional()
});
const mutationAuditSchema = observationalDocument({
  id: z.string().min(1),
  operation: z.enum(["create", "update", "move", "quarantine", "restore"]),
  path: z.string().min(1),
  destination: z.string().min(1).optional(),
  beforeDigest: digestSchema.optional(),
  afterDigest: digestSchema.optional(),
  timestamp: z.iso.datetime(),
  quarantineId: z.string().min(1).optional()
});
const approvalSummarySchema = observationalDocument({
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  arguments: z.json(),
  childRunId: z.string().min(1).optional(),
  childAgentId: z.string().min(1).optional()
});
const childRunSummarySchema = observationalDocument({
  runId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  status: z.string().min(1),
  steps: nonnegativeInteger,
  toolCalls: nonnegativeInteger,
  toolErrors: nonnegativeInteger,
  usage: tokenUsageSchema.optional()
});
const capabilityReportSchema = observationalDocument({
  provider: z.string().min(1),
  model: z.string().min(1),
  supportTier: z.string().min(1).optional(),
  capabilities: observationalDocument({
    streaming: z.boolean(),
    tools: z.boolean(),
    "structured-output": z.boolean(),
    "parallel-tools": z.boolean(),
    reasoning: z.boolean(),
    "web-search": z.boolean()
  })
});
const providerConfigurationSchema = z.object({
  customEndpoint: z.boolean(),
  endpointValid: z.boolean(),
  endpointSecure: z.boolean()
}).catchall(z.boolean());
const providerAvailabilitySchema = observationalDocument({
  id: z.string().min(1),
  name: z.string().min(1),
  defaultModel: z.string().min(1),
  credentialNames: z.array(z.string().min(1)),
  capabilities: z.array(z.enum(["streaming", "tool-calling", "approval-resume"])),
  support: z.enum(["certified", "provisional"]),
  configured: z.boolean(),
  credentials: z.array(observationalDocument({
    name: z.string().min(1),
    present: z.boolean()
  })),
  configuration: providerConfigurationSchema
});
const orchestrationConfigSchema = observationalDocument({
  profiles: z.array(z.enum(["explorer", "implementer", "tester", "reviewer"])),
  childBudget: budgetConfigSchema,
  childTimeoutMs: nonnegativeInteger,
  maxParallelReviews: nonnegativeInteger
});
const executionConfigSchema = z.discriminatedUnion("backend", [
  observationalDocument({ backend: z.literal("none") }),
  observationalDocument({
    backend: z.literal("oci"),
    policyVersion: z.string().min(1),
    runtime: z.enum(["docker", "podman"]),
    image: z.string().min(1),
    allowedCommands: z.array(z.string().min(1)),
    shellMode: z.enum(["deny", "ask"]),
    maxProcessRuntimeMs: nonnegativeInteger,
    maxProcessOutputBytes: nonnegativeInteger,
    maxMemoryMb: nonnegativeInteger,
    maxPids: nonnegativeInteger,
    maxCpus: z.number().positive(),
    maxWorkspaceBytes: nonnegativeInteger,
    maxFileWriteBytes: nonnegativeInteger,
    tmpfsMb: nonnegativeInteger
  })
]);
const executionBindingSchema = observationalDocument({
  environmentId: z.string().min(1),
  environmentVersion: z.string().min(1).optional(),
  fingerprint: z.string().min(1),
  workspaceId: z.string().min(1).optional()
});
const ociImageSchema = observationalDocument({
  runtime: z.enum(["docker", "podman"]),
  runtimeVersion: z.string().min(1),
  imageReference: z.string().min(1),
  imageId: z.string().min(1),
  imageDigest: z.string().min(1)
});
const runExecutionSchema = z.discriminatedUnion("backend", [
  observationalDocument({ backend: z.literal("none") }),
  observationalDocument({
    backend: z.literal("oci"),
    binding: executionBindingSchema,
    image: ociImageSchema
  })
]);
const migrationResultSchema = observationalDocument({
  scannedRuns: nonnegativeInteger,
  migratedRuns: nonnegativeInteger,
  migratedToolCalls: nonnegativeInteger
});
const runStoreSchema = observationalDocument({
  backend: z.enum(["sqlite", "file"]),
  stateDirectory: z.string().min(1),
  migration: migrationResultSchema.optional()
});
const doctorCheckSchema = observationalDocument({
  id: z.string().min(1),
  status: z.enum(["pass", "warn", "fail"]),
  message: z.string(),
  details: z.record(z.string(), z.union([
    z.boolean(), z.number(), z.string(), z.array(z.string())
  ]))
});
const doctorConfigurationSchema = observationalDocument({
  provider: z.string().min(1),
  model: z.string().min(1),
  workspace: z.string().min(1),
  stateDirectory: z.string().min(1),
  storeBackend: z.enum(["sqlite", "file"]),
  scope: scopeSchema,
  maxSteps: nonnegativeInteger,
  timeoutMs: nonnegativeInteger,
  budget: budgetConfigSchema,
  costBudget: observationalDocument({
    maxCostUsd: z.number().nonnegative(),
    inputCostPer1kTokens: z.number().nonnegative(),
    outputCostPer1kTokens: z.number().nonnegative()
  }).optional(),
  compaction: observationalDocument({
    maxMessages: nonnegativeInteger,
    maxEstimatedInputTokens: nonnegativeInteger,
    keepRecentMessages: nonnegativeInteger
  }),
  allowedChecks: z.array(z.string().min(1)),
  requiredCapabilities: z.array(z.enum([
    "streaming", "tools", "structured-output", "parallel-tools", "reasoning", "web-search"
  ])),
  orchestration: orchestrationConfigSchema,
  context: observationalDocument({ enabled: z.boolean(), configPath: z.string().min(1) }),
  execution: executionConfigSchema,
  mcpConfigPath: z.string().min(1).optional()
});

export const cliRunResultDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("run-result"),
  ...runIdentity,
  output: z.string(),
  steps: nonnegativeInteger,
  toolCalls: nonnegativeInteger,
  mutations: z.array(mutationAuditSchema),
  pendingApprovals: z.array(approvalSummarySchema),
  children: z.array(childRunSummarySchema),
  usage: tokenUsageSchema.optional(),
  budget: budgetStatusSchema,
  costBudget: observationalDocument({
    limitUsd: z.number().nonnegative(),
    estimate: costEstimateSchema
  }).optional(),
  scope: scopeSchema,
  capabilities: capabilityReportSchema,
  orchestration: observationalDocument({
    profiles: orchestrationConfigSchema.shape.profiles,
    childBudget: budgetConfigSchema,
    mcpServers: z.array(z.string().min(1))
  }),
  execution: runExecutionSchema,
  store: runStoreSchema,
  stateDirectory: z.string()
});

export const cliProviderDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("providers"),
  providers: z.array(providerAvailabilitySchema)
});

export const cliInitDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("init"),
  profile: observationalDocument({
    name: z.string().min(1),
    path: z.string().min(1),
    schemaVersion: nonnegativeInteger,
    provider: z.enum(PROVIDERS),
    model: z.string().min(1)
  }),
  credential: observationalDocument({
    configured: z.boolean(),
    names: z.array(z.string().min(1))
  }),
  next: observationalDocument({
    doctor: z.string().min(1),
    run: z.string().min(1)
  })
});

export const cliDoctorDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("doctor"),
  ok: z.boolean(),
  harnessVersion: z.string().min(1),
  configSchemaVersion: nonnegativeInteger,
  configuration: doctorConfigurationSchema,
  checks: z.array(doctorCheckSchema),
  providers: z.array(providerAvailabilitySchema)
});

export const cliReviewGroupDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("review-group"),
  groupId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  profiles: z.array(z.string().min(1)).min(1),
  outputs: z.array(observationalDocument({
    status: z.enum(["fulfilled", "rejected"]),
    name: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    runStatus: z.string().min(1).optional(),
    output: z.string().optional(),
    steps: nonnegativeInteger.optional(),
    usage: tokenUsageSchema.optional(),
    error: observationalDocument({
      code: z.enum(HARNESS_ERROR_CODES),
      category: z.enum([
        "configuration", "usage", "workspace", "state", "provider", "approval", "execution"
      ]),
      retryable: z.boolean()
    }).optional()
  }))
});

export const cliRunListDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("run-list"),
  scope: scopeSchema,
  backend: z.string().min(1),
  runs: z.array(runSummarySchema)
});

const runInspectionShape = {
  run: runSummarySchema,
  budget: jsonObjectSchema,
  snapshot: jsonObjectSchema,
  trace: jsonObjectSchema,
  hierarchy: jsonObjectSchema,
  ledger: jsonObjectSchema,
  toolJournal: z.array(jsonObjectSchema)
};

export const cliRunInspectionDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("run-inspection"),
  ...runInspectionShape
});

export const cliRunExportDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("run-export"),
  ...runInspectionShape
});

export const cliRunCancellationDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("run-cancellation"),
  cascade: z.boolean(),
  run: runSummarySchema.optional(),
  parent: runSummarySchema.optional(),
  children: z.array(runSummarySchema).optional()
}).superRefine((document, context) => {
  if ((!document.cascade && !document.run) || (document.cascade && (!document.parent || !document.children))) {
    context.addIssue({ code: "custom", message: "Cancellation payload does not match cascade mode." });
  }
});

export const cliRunCleanupDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("run-cleanup"),
  before: nonnegativeInteger,
  statuses: z.array(z.string().min(1)),
  deleted: nonnegativeInteger
});

export const cliSessionListDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("session-list"),
  sessions: z.array(sessionSchema)
});

export const cliSessionDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("session"),
  session: sessionSchema
});

export const cliChangeEnvelopeVerificationDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("change-envelope-verification"),
  valid: z.boolean(),
  verificationScope: z.literal("integrity-expiration-and-preconditions-only"),
  issues: z.array(jsonObjectSchema),
  integrity: jsonObjectSchema,
  expiration: jsonObjectSchema,
  checks: jsonObjectSchema,
  approvals: jsonObjectSchema,
  externalAttestations: jsonObjectSchema
});

export const cliStateStatusDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("state-status"),
  compatible: z.boolean(),
  schemas: jsonObjectSchema,
  counts: z.record(z.string(), nonnegativeInteger)
});

export const cliStateExportDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("state-export"),
  path: z.string().min(1),
  checksum: digestSchema,
  counts: z.record(z.string(), nonnegativeInteger)
});

export const cliStateImportDocumentSchema = observationalDocument({
  ...jsonBase,
  kind: z.literal("state-import"),
  dryRun: z.boolean(),
  checksum: digestSchema,
  inserted: z.record(z.string(), nonnegativeInteger),
  identical: nonnegativeInteger
});

export const cliErrorDocumentSchema = observationalDocument({
  schemaVersion: z.literal(HARNESS_ERROR_SCHEMA_VERSION),
  kind: z.literal("error"),
  error: observationalDocument({
    code: z.enum(HARNESS_ERROR_CODES),
    category: z.enum([
      "configuration",
      "usage",
      "workspace",
      "state",
      "provider",
      "approval",
      "execution"
    ]),
    retryable: z.boolean()
  })
});

/**
 * Stable parser for final structured output. Observational documents retain
 * additive fields; the digest-bound change envelope remains strict.
 */
export const cliJsonDocumentSchema = z.union([
  cliRunResultDocumentSchema,
  cliInitDocumentSchema,
  cliProviderDocumentSchema,
  cliDoctorDocumentSchema,
  cliReviewGroupDocumentSchema,
  cliRunListDocumentSchema,
  cliRunInspectionDocumentSchema,
  cliRunExportDocumentSchema,
  cliRunCancellationDocumentSchema,
  cliRunCleanupDocumentSchema,
  cliSessionListDocumentSchema,
  cliSessionDocumentSchema,
  cliChangeEnvelopeVerificationDocumentSchema,
  cliStateStatusDocumentSchema,
  cliStateExportDocumentSchema,
  cliStateImportDocumentSchema,
  cliErrorDocumentSchema,
  changeEnvelopeSchema
]);

const runEvent = <Type extends string, T extends z.ZodRawShape>(type: Type, shape: T) => observationalDocument({
  ...eventBase,
  kind: z.literal("run-event"),
  type: z.literal(type),
  ...shape
});

export const cliRunEventDocumentSchema = z.discriminatedUnion("type", [
  runEvent("text-delta", { textDelta: z.string() }),
  runEvent("tool-call", {
    toolCallId: z.string().min(1),
    toolName: z.string().min(1)
  }),
  runEvent("tool-result", {
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    isError: z.boolean()
  }),
  runEvent("tool-approval-request", {
    approvalRequestId: z.string().min(1),
    approvalKind: z.string().min(1),
    toolName: z.string().min(1)
  }),
  runEvent("agent-approval-request", {
    approvalRequestId: z.string().min(1),
    approvalKind: z.string().min(1),
    toolName: z.string().min(1)
  }),
  runEvent("agent-approval-resolved", {
    approvalRequestId: z.string().min(1),
    approved: z.boolean()
  }),
  runEvent("provider-data", { provider: z.string().min(1) }),
  runEvent("image-generation", {
    provider: z.string().min(1),
    partial: z.boolean(),
    id: z.string().min(1).optional(),
    index: nonnegativeInteger.optional()
  }),
  runEvent("finish", {
    finishReason: z.string().min(1).optional(),
    usage: jsonObjectSchema.optional()
  }),
  runEvent("error", { error: z.literal("Provider stream failed.") }),
  runEvent("agent-run-start", {
    currentStep: nonnegativeInteger,
    maxSteps: nonnegativeInteger
  }),
  runEvent("agent-step-start", { stepIndex: nonnegativeInteger }),
  runEvent("agent-step-finish", {
    stepIndex: nonnegativeInteger,
    status: z.string().min(1),
    toolCalls: nonnegativeInteger
  }),
  runEvent("agent-compaction", {
    compactionId: z.string().min(1),
    reasons: z.array(z.string().min(1)),
    messageCountBefore: nonnegativeInteger,
    messageCountAfter: nonnegativeInteger
  }),
  runEvent("agent-run-finish", {
    runId: z.string().min(1),
    status: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1)
  })
]);

export const cliStreamResultDocumentSchema = observationalDocument({
  ...eventBase,
  kind: z.literal("run-stream-result"),
  ...runIdentity,
  steps: nonnegativeInteger,
  toolCalls: nonnegativeInteger,
  pendingApprovals: z.array(observationalDocument({
    id: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1),
    childRunId: z.string().min(1).optional(),
    childAgentId: z.string().min(1).optional()
  })),
  children: z.array(observationalDocument({
    runId: z.string().min(1),
    status: z.string().min(1)
  }))
});

export const cliStreamErrorDocumentSchema = observationalDocument({
  ...eventBase,
  kind: z.literal("run-stream-error"),
  error: cliErrorDocumentSchema.shape.error
});

/** Stable parser for one JSONL record. Every record kind is unambiguous. */
export const cliJsonLineDocumentSchema = z.union([
  cliRunEventDocumentSchema,
  cliStreamResultDocumentSchema,
  cliStreamErrorDocumentSchema
]);

export type CliJsonDocument = z.infer<typeof cliJsonDocumentSchema>;
export type CliJsonLineDocument = z.infer<typeof cliJsonLineDocumentSchema>;
export type CliInitDocument = z.infer<typeof cliInitDocumentSchema>;
export type CliRunResultDocument = z.infer<typeof cliRunResultDocumentSchema>;
export type CliReviewGroupDocument = z.infer<typeof cliReviewGroupDocumentSchema>;
export type CliRunListDocument = z.infer<typeof cliRunListDocumentSchema>;
export type CliRunInspectionDocument = z.infer<typeof cliRunInspectionDocumentSchema>;
export type CliSessionDocument = z.infer<typeof cliSessionDocumentSchema>;
export type CliChangeEnvelopeVerificationDocument = z.infer<typeof cliChangeEnvelopeVerificationDocumentSchema>;
export type CliRunEventDocument = z.infer<typeof cliRunEventDocumentSchema>;
export type CliStreamResultDocument = z.infer<typeof cliStreamResultDocumentSchema>;
export type CliStreamErrorDocument = z.infer<typeof cliStreamErrorDocumentSchema>;

export const parseCliJsonDocument = (input: unknown): CliJsonDocument =>
  cliJsonDocumentSchema.parse(input);

export const parseCliJsonLineDocument = (input: string | unknown): CliJsonLineDocument =>
  cliJsonLineDocumentSchema.parse(typeof input === "string" ? JSON.parse(input) : input);
