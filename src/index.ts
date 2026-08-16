export {
  HARNESS_CONFIG_SCHEMA_VERSION,
  PROVIDERS,
  PROVIDER_DESCRIPTORS,
  createProviderModel,
  parseProvider,
  providerAvailability,
  providerDescriptor,
  resolveHarnessConfig
} from "./config.js";
export type {
  HarnessConfig,
  HarnessConfigInput,
  HarnessProvider,
  ProviderCapability,
  ProviderDescriptor,
  ProviderSupport
} from "./config.js";

export { BUN_ENGINE_RANGE, HARNESS_VERSION } from "./version.js";

export {
  HARNESS_INSTRUCTIONS,
  appendUserMessage,
  createHarness,
  runHarness
} from "./harness.js";
export type {
  CreateHarnessOptions,
  HarnessRunOptions,
  ZhivexHarness
} from "./harness.js";

export { Workspace } from "./workspace.js";
export type {
  CommandResult,
  HarnessCheck,
  SearchMatch,
  WorkspaceFile
} from "./workspace.js";
