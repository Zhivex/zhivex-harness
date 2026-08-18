export {
  DEFAULT_ALLOWED_CHECKS,
  DEFAULT_OCI_EXECUTION,
  DEFAULT_SUBAGENT_BUDGET,
  HARNESS_CONFIG_SCHEMA_VERSION,
  HARNESS_EXECUTION_BACKENDS,
  HARNESS_EXECUTION_POLICY_VERSION,
  HARNESS_OCI_RUNTIMES,
  HARNESS_REQUIRED_CAPABILITIES,
  HARNESS_SUBAGENT_PROFILES,
  PROVIDERS,
  PROVIDER_DESCRIPTORS,
  createProviderModel,
  defaultHarnessNamespace,
  parseProvider,
  providerAvailability,
  providerDescriptor,
  resolveHarnessConfig
} from "./config.js";
export type {
  HarnessBudget,
  HarnessCompactionConfig,
  HarnessConfig,
  HarnessConfigInput,
  HarnessCostBudget,
  HarnessExecutionBackend,
  HarnessExecutionConfig,
  HarnessOciRuntime,
  HarnessOrchestrationConfig,
  HarnessProvider,
  HarnessRequiredCapability,
  HarnessStoreBackend,
  HarnessSubagentProfile,
  ProviderCapability,
  ProviderDescriptor,
  ProviderSupport
} from "./config.js";

export {
  CliOciRuntimeAdapter,
  HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
  HARNESS_OCI_LABEL,
  HARNESS_OCI_LABEL_VALUE,
  cleanupHarnessExecutionArtifacts,
  createHarnessOciExecutionEnvironment,
  describeOciCommand,
  executionFingerprintInput,
  harnessExecutionSession
} from "./execution-environment.js";
export type {
  CreateHarnessOciEnvironmentOptions,
  EnvironmentPatchImportResult,
  EnvironmentPatchInspection,
  ExecutionArtifactCleanupResult,
  HarnessExecutionSession,
  HarnessOciExecutionEnvironment,
  HarnessOciRuntimeAdapter,
  OciImageInspection,
  OciCommandResult,
  OciRunRequest
} from "./execution-environment.js";

export {
  assertHarnessModelCapabilities,
  inspectHarnessModelCapabilities,
  selectHarnessModel
} from "./capabilities.js";
export type {
  HarnessModelCandidate,
  HarnessModelCapabilityReport,
  HarnessModelSelection
} from "./capabilities.js";

export {
  HARNESS_MCP_CONFIG_SCHEMA_VERSION,
  HARNESS_MCP_PERMISSIONS,
  createHarnessMcpTools,
  createHttpMcpClient,
  loadHarnessMcpConfiguration,
  normalizeHarnessMcpConfiguration
} from "./mcp.js";
export type {
  HarnessMcpClients,
  HarnessMcpConfiguration,
  HarnessMcpPermission,
  HarnessMcpServerConfig,
  HarnessMcpTransport,
  McpClient,
  McpListedTool
} from "./mcp.js";

export {
  HARNESS_SUBAGENT_PROFILE_DESCRIPTORS,
  createHarnessSubagents,
  runHarnessReviewGroup
} from "./orchestration.js";
export type {
  HarnessReviewGroupResult,
  HarnessSubagentProfileDescriptor,
  HarnessSubagentRuntime
} from "./orchestration.js";

export { BUN_ENGINE_RANGE, HARNESS_VERSION } from "./version.js";

export {
  EDIT_CONTRACT_SCHEMA_VERSION,
  EDIT_DIGEST_ALGORITHM,
  MAX_EDIT_CHANGES,
  MAX_EDIT_FILE_BYTES,
  MAX_EDIT_PROPOSAL_BYTES,
  applyEditProposalInputSchema,
  createEditProposal,
  editContractDocument,
  editChangeSchema,
  editChangesSchema,
  editProposalInputSchema,
  editProposalChangeSchema,
  editProposalSchema,
  fileDigestSchema,
  moveFileInputSchema,
  mutationAuditEntrySchema,
  mutationOperationSchema,
  quarantineFileInputSchema,
  restoreFileInputSchema,
  validateEditProposal,
  workspaceFilePathSchema
} from "./edit-contracts.js";
export type {
  ApplyEditProposalInput,
  ApplyPatchResult,
  EditContractDocument,
  EditChange,
  EditProposal,
  EditProposalChange,
  FileDigest,
  MoveFileInput,
  MoveFileResult,
  MutationAuditEntry,
  MutationOperation,
  QuarantineFileInput,
  QuarantineFileResult,
  RestoreFileInput,
  RestoreFileResult
} from "./edit-contracts.js";

export {
  HARNESS_INSTRUCTIONS,
  appendUserMessage,
  createExecutionEnvironmentTools,
  createHarness,
  runHarness
} from "./harness.js";

export {
  HARNESS_OPERATIONS_SCHEMA_VERSION,
  HARNESS_SQLITE_FILE,
  TERMINAL_RUN_STATUSES,
  cancelHarnessRun,
  cleanupHarnessRuns,
  inspectHarnessRun,
  listHarnessRuns,
  migrateLegacyFileRuns,
  openHarnessPersistence
} from "./operations.js";

export { validateStateDirectory } from "./state-directory.js";
export type {
  HarnessMigrationResult,
  HarnessPersistence,
  HarnessRunQuery
} from "./operations.js";
export type {
  CreateHarnessOptions,
  HarnessRunOptions,
  ZhivexHarness
} from "./harness.js";

export { Workspace } from "./workspace.js";
export type {
  CommandResult,
  HarnessCheck,
  ListFilesOptions,
  SearchFilesOptions,
  SearchMatch,
  WorkspaceFile
} from "./workspace.js";
