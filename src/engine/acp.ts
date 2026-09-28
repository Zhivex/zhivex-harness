/** Explicit Harness integration surface. See contracts/engine-api.json for stability tiers. */
export { createAcpConnection } from "../client/acp.js";
export type { AcpConnectionOptions } from "../client/acp.js";
export { serveAcpStdio } from "../client/acp-stdio.js";
