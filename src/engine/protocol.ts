/** Explicit Harness integration surface. See contracts/engine-api.json for stability tiers. */
export { HARNESS_CLIENT_PROTOCOL_VERSION, harnessClientCommandSchema, harnessClientRequestSchema } from "../client/protocol.js";
export type { HarnessClientCommand, HarnessClientRequest, HarnessClientErrorCode, HarnessClientSession, HarnessClientRun, HarnessClientData, HarnessClientResponse, HarnessClientNegotiation, HarnessClientAdapterOptions, HarnessClientAdapter } from "../client/protocol.js";
export { CLI_JSON_SCHEMA_VERSION, CLI_EVENT_SCHEMA_VERSION, streamEventDocument, serializeStreamEvent, streamResultDocument, serializeStreamResult } from "../client/stream.js";
export type { StreamRunResultSource } from "../client/stream.js";
export type { HarnessActivityEvent, HarnessActivityRun, HarnessActivitySnapshot, HarnessActivityPage } from "../client/service-events.js";
export type { ApprovalDecisionView } from "../approvals/approval-history.js";
