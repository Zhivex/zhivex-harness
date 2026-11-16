import { createHash } from "node:crypto";
import type { AgentStoreScope } from "@zhivex-ai/core";

// Physical identity compatibility for the pinned Core 1.30.1 store format.
// Logical run/scope checks remain mandatory; never infer ownership from a key.
export const sdkCanonicalKey = (kind: "agent-run" | "agent-memory", scope: AgentStoreScope, value: string) =>
  `${kind}:v2:${createHash("sha256").update(JSON.stringify([
    JSON.stringify([scope.namespace ?? null, scope.tenantId, scope.userId ?? null]), value
  ])).digest("hex")}`;

export const sdkLegacyKey = (scope: AgentStoreScope, value: string) =>
  `${encodeURIComponent(scope.namespace ?? "default")}:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId ?? "*")}:${value}`;

export const sdkRunKeyMatches = (key: string, scope: AgentStoreScope, value: string) =>
  key === sdkCanonicalKey("agent-run", scope, value) || key === sdkLegacyKey(scope, value);
