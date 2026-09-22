/** Compatibility facade. New internal consumers use the focused modules. */

export { HARNESS_CLIENT_PROTOCOL_VERSION } from "./protocol.js";
export { harnessClientCommandSchema } from "./protocol.js";
export { harnessClientRequestSchema } from "./protocol.js";
export type { HarnessClientCommand } from "./protocol.js";
export type { HarnessClientRequest } from "./protocol.js";
export type { HarnessClientErrorCode } from "./protocol.js";
export type { HarnessClientSession } from "./protocol.js";
export type { HarnessClientRun } from "./protocol.js";
export type { HarnessClientData } from "./protocol.js";
export type { HarnessClientResponse } from "./protocol.js";
export type { HarnessClientNegotiation } from "./protocol.js";
export type { HarnessClientAdapterOptions } from "./protocol.js";
export type { HarnessClientAdapter } from "./protocol.js";
export { createHarnessClientAdapter } from "./adapter.js";
