import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HarnessApprovalError,
  HarnessConfigError,
  HarnessExecutionError,
  HarnessProviderError,
  HarnessStateConflictError,
  HarnessWorkspaceError,
  Workspace,
  createProviderModel,
  createProviderRegistry,
  harnessErrorDocument,
  loadHarnessMcpConfiguration,
  normalizeHarnessMcpConfiguration,
  normalizeHarnessError,
  openCliSessionStore,
  resolveHarnessConfig,
  validateStateDirectory
} from "../src/index.js";
import {
  annotateCliStreamError,
  cliStreamErrorSequence,
  terminalErrorMessage
} from "../src/cli.js";

describe("stable HarnessError taxonomy", () => {
  test("types configuration, workspace, provider, and state-conflict boundaries", async () => {
    expect(() => resolveHarnessConfig({ maxSteps: 0 })).toThrow(HarnessConfigError);
    await expect(validateStateDirectory("/tmp/workspace", "/tmp/workspace"))
      .rejects.toThrow(HarnessWorkspaceError);
    await expect(Workspace.open(path.join(os.tmpdir(), "zhivex-definitely-missing-workspace")))
      .rejects.toThrow(HarnessWorkspaceError);
    const missingPackageRoot = await mkdtemp(path.join(os.tmpdir(), "zhivex-workspace-error-"));
    try {
      const workspace = await Workspace.open(missingPackageRoot);
      await expect(workspace.readFile(".env")).rejects.toThrow(HarnessWorkspaceError);
    } finally {
      await rm(missingPackageRoot, { recursive: true, force: true });
    }
    expect(() => normalizeHarnessMcpConfiguration({ schemaVersion: 1, servers: [{}] }))
      .toThrow(HarnessConfigError);
    await expect(loadHarnessMcpConfiguration(
      missingPackageRoot,
      path.join(missingPackageRoot, "missing-mcp.json")
    )).rejects.toThrow(HarnessWorkspaceError);

    const registry = createProviderRegistry([{
      descriptor: {
        id: "fixture",
        name: "Fixture",
        defaultModel: "fixture-model",
        credentialNames: [],
        capabilities: [],
        support: "provisional"
      },
      diagnostics: {},
      factory: () => { throw new Error("provider-secret"); }
    }]);
    expect(() => createProviderModel(
      { provider: "fixture", model: "fixture-model" },
      {},
      registry
    )).toThrow(HarnessProviderError);

    const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-error-taxonomy-"));
    const workspace = path.join(root, "workspace");
    const stateDirectory = path.join(root, "state");
    await mkdir(workspace);
    await mkdir(stateDirectory);
    try {
      const store = await openCliSessionStore({
        workspace,
        stateDirectory,
        scope: { tenantId: "local", namespace: "errors" }
      });
      const session = await store.create({ title: "revision" });
      await store.rename(session.sessionId, "first", { expectedRevision: 0 });
      await expect(store.rename(session.sessionId, "stale", { expectedRevision: 0 }))
        .rejects.toThrow(HarnessStateConflictError);
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes transient provider, approval, and execution failures without message leakage", () => {
    const transient = normalizeHarnessError(Object.assign(new Error("provider-secret"), { status: 503 }));
    expect(transient).toBeInstanceOf(HarnessProviderError);
    expect(transient).toMatchObject({ code: "PROVIDER_UNAVAILABLE", category: "provider", retryable: true });
    const mixedStatus = normalizeHarnessError(Object.assign(new Error("provider-secret"), {
      status: "UNAVAILABLE",
      statusCode: 503
    }));
    expect(mixedStatus).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });

    const documents = [
      harnessErrorDocument(new HarnessApprovalError("approval-secret")),
      harnessErrorDocument(new HarnessExecutionError("execution-secret", { cause: "cause-secret" })),
      harnessErrorDocument(Object.assign(new Error("state-secret"), { name: "ConflictError" }))
    ];
    expect(documents.map((document) => document.error.code)).toEqual([
      "APPROVAL_REQUIRED",
      "EXECUTION_FAILED",
      "STATE_CONFLICT"
    ]);
    const serialized = JSON.stringify(documents);
    for (const secret of ["approval-secret", "execution-secret", "cause-secret", "state-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("preserves the next JSONL sequence and redacts terminal messages", () => {
    const annotated = annotateCliStreamError(new Error("token=abcdefgh12345678"), 7);
    expect(cliStreamErrorSequence(annotated)).toBe(8);
    expect(terminalErrorMessage(annotated)).not.toContain("abcdefgh12345678");
  });
});
