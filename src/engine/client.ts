/** Explicit Harness integration surface. See contracts/engine-api.json for stability tiers. */
export { HARNESS_CLIENT_PROTOCOL_VERSION, harnessClientCommandSchema, harnessClientRequestSchema } from "../client/protocol.js";
export type { HarnessClientCommand, HarnessClientRequest, HarnessClientErrorCode, HarnessClientSession, HarnessClientRun, HarnessClientData, HarnessClientResponse, HarnessClientNegotiation, HarnessClientAdapterOptions, HarnessClientAdapter } from "../client/protocol.js";
export { createHarnessClientAdapter } from "../client/adapter.js";
export { runResultDocument } from "../client/run-document.js";
export { terminalContinuationMessages } from "../client/continuation.js";
