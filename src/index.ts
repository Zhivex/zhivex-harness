export {
  DEFAULT_ALLOWED_CHECKS,
  HARNESS_CONFIG_SCHEMA_VERSION,
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
  HarnessProvider,
  HarnessStoreBackend,
  ProviderCapability,
  ProviderDescriptor,
  ProviderSupport
} from "./config.js";

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
