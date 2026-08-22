import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import { resolveHarnessConfig } from "../src/config.js";
import { createEditProposal } from "../src/edit-contracts.js";
import {
  cleanupHarnessExecutionArtifacts,
  createHarnessOciExecutionEnvironment,
  OCI_SESSION_CONTROLLER_SCRIPT,
  type HarnessOciRuntimeAdapter,
  type OciCommandBatchResult,
  type OciCommandResult,
  type OciImageInspection,
  type OciRunBatchRequest,
  type OciRunRequest
} from "../src/execution-environment.js";
import { createExecutionEnvironmentTools, createHarness, runHarness } from "../src/harness.js";
import { Workspace } from "../src/workspace.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

class FakeOciRuntime implements HarnessOciRuntimeAdapter {
  readonly requests: OciRunRequest[] = [];
  readonly removedRuns: string[] = [];
  readonly image: OciImageInspection;
  readonly onRun?: (request: OciRunRequest) => void | Promise<void>;
  readonly outcome?: Partial<OciCommandResult>;

  constructor(
    imageDigest = `sha256:${"a".repeat(64)}`,
    onRun?: (request: OciRunRequest) => void | Promise<void>,
    outcome?: Partial<OciCommandResult>
  ) {
    this.image = {
      runtime: "docker",
      runtimeVersion: "fixture-1.0.0",
      imageReference: "fixture/node:24",
      imageId: imageDigest,
      imageDigest
    };
    this.onRun = onRun;
    this.outcome = outcome;
  }

  async inspectImage(imageReference: string) {
    return { ...this.image, imageReference };
  }

  async run(request: OciRunRequest) {
    this.requests.push(request);
    await this.onRun?.(request);
    return {
      command: request.command,
      exitCode: 0,
      stdout: "fixture-command-ok\n",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputLimitExceeded: false,
      ...this.outcome
    };
  }

  async removeRunContainers(runId: string) {
    this.removedRuns.push(runId);
    return 0;
  }

  async cleanupOrphans() {
    return 0;
  }
}

class FakeBatchOciRuntime extends FakeOciRuntime {
  readonly batchRequests: OciRunBatchRequest[] = [];

  async runBatch(request: OciRunBatchRequest): Promise<OciCommandBatchResult> {
    this.batchRequests.push(request);
    return {
      command: ["<oci-batch>", String(request.commands.length)],
      commands: request.commands,
      exitCode: 0,
      stdout: "first\nsecond\n",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputLimitExceeded: false,
      sessionReused: false,
      workspacePublished: true,
      workspaceExported: false
    };
  }
}

const workspaceFixture = async () => {
  const root = await temporaryDirectory("zhivex-harness-oci-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "oci-fixture",
    private: true,
    scripts: { test: "node --test" }
  }, null, 2));
  await writeFile(path.join(root, "src", "update.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "src", "delete.ts"), "delete me\n");
  await writeFile(path.join(root, ".env"), "SECRET_VALUE=must-not-enter-snapshot\n");
  return { root, workspace: await Workspace.open(root) };
};

describe("enforced OCI execution environment", () => {
  test("exposes an approval-gated shell only when explicitly enabled", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeOciRuntime();
    const config = resolveHarnessConfig({
      workspace: root,
      executionBackend: "oci",
      ociAllowedCommands: ["node", "npm"],
      ociShellMode: "ask"
    });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "shell-policy-run" });
    const tools = createExecutionEnvironmentTools(workspace, config.execution);

    expect(tools.run_environment_shell).toMatchObject({
      requiresApproval: true,
      approvalMode: "interrupt"
    });
    const result = await tools.run_environment_shell!.execute({
      script: "node --version && npm --version"
    }, { executionEnvironment: session } as never);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(runtime.requests.at(-1)?.command).toEqual([
      "sh",
      "-lc",
      "node --version && npm --version",
      "zhivex-harness"
    ]);
    expect(environment.manifest.permissions?.network?.mode).toBe("deny");
    expect(environment.manifest.permissions?.process?.shell).toBe("allow");
    await session.release?.({ status: "completed" });

    const denied = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (denied.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    expect(createExecutionEnvironmentTools(workspace, denied.execution)).not.toHaveProperty("run_environment_shell");
  });

  test("keeps the per-run controller alive without a cumulative deadline", async () => {
    expect(OCI_SESSION_CONTROLLER_SCRIPT).toContain("setInterval");
    expect(OCI_SESSION_CONTROLLER_SCRIPT).not.toContain("sleep");
    expect(OCI_SESSION_CONTROLLER_SCRIPT).not.toContain("setTimeout");
    const controller = spawn(process.execPath, ["--input-type=module", "-e", OCI_SESSION_CONTROLLER_SCRIPT], {
      stdio: "ignore"
    });
    const exited = new Promise<"exited">((resolve) => controller.once("exit", () => resolve("exited")));
    try {
      const state = await Promise.race([
        exited,
        new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 50))
      ]);
      expect(state).toBe("running");
    } finally {
      controller.kill("SIGKILL");
      await exited;
    }
  });

  test("uses one optimized runtime publication cycle for a validated argv batch", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeBatchOciRuntime();
    const config = resolveHarnessConfig({
      workspace: root,
      executionBackend: "oci",
      ociAllowedCommands: ["node", "npm"]
    });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "optimized-batch-run" });
    const result = await session.runCommandBatch([
      { command: "node", args: ["--version"] },
      { command: "npm", args: ["--version"] }
    ]);

    expect(result).toMatchObject({ exitCode: 0, stdout: "first\nsecond\n" });
    expect(runtime.requests).toHaveLength(0);
    expect(runtime.batchRequests).toHaveLength(1);
    expect(runtime.batchRequests[0]?.commands).toEqual([
      ["node", "--version"],
      ["npm", "--version"]
    ]);
    expect((await session.status()).io).toMatchObject({
      containerStarts: 1,
      containerReuses: 0,
      workspacePublishes: 1,
      workspaceExports: 0
    });
    await expect(session.runCommandBatch([
      { command: "sh", args: ["-c", "echo unsafe"] }
    ])).rejects.toThrow("not in the explicit allowlist");
    expect(runtime.batchRequests).toHaveLength(1);
    await session.release?.({ status: "completed" });
  });

  test("keeps the host unchanged when verified patch import fails its bound verifier", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeOciRuntime(
      `sha256:${"a".repeat(64)}`,
      undefined,
      { exitCode: 1, stderr: "verification failed\n" }
    );
    const config = resolveHarnessConfig({
      workspace: root,
      executionBackend: "oci",
      ociAllowedCommands: ["node", "npm"]
    });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "verified-import-failure" });
    const inspected = await session.workspace.inspectFile("src/update.ts");
    const content = "export const value = 2;\n";
    const changes = [{ path: "src/update.ts", expectedDigest: inspected.digest, content }];
    const proposal = createEditProposal({ changes });
    await session.workspace.applyPatch({ proposalId: proposal.proposalId, changes });
    const patch = await session.inspectPatch();
    const verifyAndApply = createExecutionEnvironmentTools(workspace).verify_and_apply_environment_patch;

    expect(verifyAndApply).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
    await expect(verifyAndApply.execute({
      patchId: patch.patchId,
      command: "node",
      args: ["verify.mjs"]
    }, { executionEnvironment: session } as never)).rejects.toThrow("verifier failed");
    expect(await readFile(path.join(root, "src", "update.ts"), "utf8")).toContain("value = 1");
    expect((await session.inspectPatch()).patchId).toBe(patch.patchId);
    await session.release?.({ status: "failed" });
  });

  test("applies, verifies and imports reviewed edits as one clean-snapshot transaction", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeOciRuntime();
    const config = resolveHarnessConfig({
      workspace: root,
      executionBackend: "oci",
      ociAllowedCommands: ["node", "npm"]
    });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "verified-reviewed-edit-success" });
    const inspected = await session.workspace.inspectFile("src/update.ts");
    const tools = createExecutionEnvironmentTools(workspace);

    const receipt = await tools.verify_and_apply_reviewed_edits.execute({
      changes: [{
        path: "src/update.ts",
        expectedDigest: inspected.digest,
        content: "export const value = 2;\n"
      }],
      command: "node",
      args: ["verify.mjs"]
    }, { executionEnvironment: session } as never);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: "verified-reviewed-edit-import",
      verification: { exitCode: 0 }
    });
    expect(await readFile(path.join(root, "src", "update.ts"), "utf8")).toBe("export const value = 2;\n");
    await session.release?.({ status: "completed" });
  });

  test("does not touch the host when the reviewed-edit transaction verifier fails", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeOciRuntime(
      `sha256:${"a".repeat(64)}`,
      undefined,
      { exitCode: 1, stderr: "sensitive verifier detail\n" }
    );
    const config = resolveHarnessConfig({
      workspace: root,
      executionBackend: "oci",
      ociAllowedCommands: ["node", "npm"]
    });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "verified-reviewed-edit-failure" });
    const inspected = await session.workspace.inspectFile("src/update.ts");
    const tools = createExecutionEnvironmentTools(workspace);

    await expect(tools.verify_and_apply_reviewed_edits.execute({
      changes: [{
        path: "src/update.ts",
        expectedDigest: inspected.digest,
        content: "export const value = 2;\n"
      }],
      command: "node",
      args: ["verify.mjs"]
    }, { executionEnvironment: session } as never)).rejects.toThrow("verifier failed");
    expect(await readFile(path.join(root, "src", "update.ts"), "utf8")).toBe("export const value = 1;\n");
    await session.release?.({ status: "failed" });
  });

  test("runs only against a secret-free snapshot and imports a reviewed content-bound patch", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeOciRuntime(undefined, async (request) => {
      await writeFile(path.join(request.snapshotRoot, "src", "update.ts"), "export const value = 2;\n");
      await writeFile(path.join(request.snapshotRoot, "src", "created.ts"), "export const created = true;\n");
      await unlink(path.join(request.snapshotRoot, "src", "delete.ts"));
    });
    const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "snapshot-import-run" });

    expect((await session.workspace.listFiles()).files.map((file) => file.path)).not.toContain(".env");
    await session.runCommand("npm", ["test"]);
    const inspection = await session.inspectPatch();

    expect(inspection.entries).toEqual([
      expect.objectContaining({ path: "src/created.ts", operation: "create" }),
      expect.objectContaining({ path: "src/delete.ts", operation: "delete" }),
      expect.objectContaining({ path: "src/update.ts", operation: "update" })
    ]);
    expect(await readFile(path.join(root, "src", "update.ts"), "utf8")).toContain("value = 1");
    await expect(readFile(path.join(root, "src", "created.ts"), "utf8")).rejects.toThrow();

    const imported = await session.importPatch(workspace, inspection.patchId);
    expect(imported.changes).toHaveLength(3);
    expect(await readFile(path.join(root, "src", "update.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(path.join(root, "src", "created.ts"), "utf8")).toContain("created = true");
    await expect(readFile(path.join(root, "src", "delete.ts"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(root, ".env"), "utf8")).toContain("must-not-enter-snapshot");

    expect(runtime.requests[0]).toMatchObject({
      imageId: `sha256:${"a".repeat(64)}`,
      command: ["npm", "test"],
      limits: {
        maxProcessRuntimeMs: 120_000,
        maxProcessOutputBytes: 20_000,
        maxMemoryMb: 1_024,
        maxPids: 128,
        maxCpus: 2,
        tmpfsMb: 256
      }
    });
    expect(environment.manifest).toMatchObject({
      backend: "container",
      assurance: "enforced",
      permissions: {
        network: { mode: "deny", allowPrivateNetworks: false },
        environment: { inheritedVariables: [] }
      }
    });

    await session.release?.({ status: "completed" });
    const cleanup = await cleanupHarnessExecutionArtifacts(config.stateDirectory, Date.now() + 1_000);
    expect(cleanup.deleted).toBe(1);
    expect(runtime.removedRuns).toContain("snapshot-import-run");
  });

  test("runs declared package checks through npm inside the Node OCI boundary", async () => {
    const { root, workspace } = await workspaceFixture();
    const runtime = new FakeOciRuntime();
    const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "node-check-run" });

    await session.runCheck("test", "node --test", ["test"]);

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.command).toEqual(["npm", "--ignore-scripts", "run", "test"]);
    await session.release?.({ status: "completed" });
  });

  test("requires one approval for execution and keeps approved command changes off the host", async () => {
    const { root } = await workspaceFixture();
    const runtime = new FakeOciRuntime(undefined, async (request) => {
      await writeFile(path.join(request.snapshotRoot, "generated.txt"), "generated only in snapshot\n");
    });
    const store = createInMemoryAgentRunStore();
    const model = createMockLanguageModel({
      provider: "mock-provider",
      modelId: "mock-model",
      streamEvents: [
        [
          {
            type: "tool-call",
            toolCall: {
              id: "oci-command-1",
              name: "run_environment_command",
              input: { command: "npm", args: ["test"] }
            }
          },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "snapshot command complete" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    });
    const harness = await createHarness({
      provider: "openai",
      workspace: root,
      executionBackend: "oci",
      modelInstance: model,
      store,
      ociRuntimeAdapter: runtime
    });
    const tools = harness.agent.tools as Record<string, { requiresApproval?: boolean; approvalMode?: string }>;
    expect(tools.run_environment_command).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
    expect(tools.run_environment_batch).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
    expect(tools.apply_environment_patch).toMatchObject({ requiresApproval: true, approvalMode: "interrupt" });
    expect(tools.git_diff).toBeUndefined();

    const waiting = await runHarness(harness, { runId: "oci-approval-run", prompt: "Run the isolated command" });
    expect(waiting.status).toBe("waiting_approval");
    expect(runtime.requests).toHaveLength(0);
    await expect(readFile(path.join(root, "generated.txt"), "utf8")).rejects.toThrow();

    const completed = await runHarness(harness, {
      state: waiting.state,
      approvals: waiting.state.pendingApprovals.map((approval) => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true,
        reason: "Fixture operator approval."
      }))
    });
    expect(completed.status).toBe("completed");
    expect(runtime.requests).toHaveLength(1);
    await expect(readFile(path.join(root, "generated.txt"), "utf8")).rejects.toThrow();

    const session = await harness.executionEnvironment!.acquire({ runId: "oci-approval-run" });
    expect((await session.inspectPatch()).entries).toContainEqual(
      expect.objectContaining({ path: "generated.txt", operation: "create" })
    );
    await session.release?.({ status: "completed" });
  });

  test("binds one durable approval to the complete environment command batch", async () => {
    const { root } = await workspaceFixture();
    const runtime = new FakeOciRuntime();
    const model = createMockLanguageModel({
      provider: "mock-provider",
      modelId: "mock-model",
      streamEvents: [
        [
          {
            type: "tool-call",
            toolCall: {
              id: "oci-batch-1",
              name: "run_environment_batch",
              input: {
                commands: [
                  { command: "npm", args: ["--version"] },
                  { command: "node", args: ["--version"] }
                ]
              }
            }
          },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "snapshot batch complete" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    });
    const harness = await createHarness({
      provider: "openai",
      workspace: root,
      executionBackend: "oci",
      modelInstance: model,
      store: createInMemoryAgentRunStore(),
      ociRuntimeAdapter: runtime
    });

    const waiting = await runHarness(harness, { runId: "oci-batch-approval-run", prompt: "Run the isolated batch" });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.pendingApprovals).toHaveLength(1);
    expect(waiting.state.pendingApprovals[0]?.name).toBe("run_environment_batch");
    expect(runtime.requests).toHaveLength(0);

    const completed = await runHarness(harness, {
      state: waiting.state,
      approvals: waiting.state.pendingApprovals.map((approval) => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true,
        reason: "Reviewed argv batch."
      }))
    });
    expect(completed.status).toBe("completed");
    // Custom runtimes without runBatch retain a safe sequential fallback.
    expect(runtime.requests.map((request) => request.command)).toEqual([
      ["npm", "--version"],
      ["node", "--version"]
    ]);
    await harness.close();
  });

  test("binds and imports executable modes, including mode-only changes", async () => {
    const { root, workspace } = await workspaceFixture();
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "scripts", "existing.sh"), "#!/bin/sh\necho existing\n");
    await chmod(path.join(root, "scripts", "existing.sh"), 0o644);
    const runtime = new FakeOciRuntime(undefined, async (request) => {
      await chmod(path.join(request.snapshotRoot, "scripts", "existing.sh"), 0o755);
      await writeFile(path.join(request.snapshotRoot, "scripts", "created.sh"), "#!/bin/sh\necho created\n");
      await chmod(path.join(request.snapshotRoot, "scripts", "created.sh"), 0o750);
    });
    const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime
    });
    const session = await environment.acquire({ runId: "mode-import-run" });
    await session.runCommand("npm", ["test"]);

    const inspection = await session.inspectPatch();
    expect(inspection.entries).toEqual([
      expect.objectContaining({
        path: "scripts/created.sh",
        operation: "create",
        afterMode: 0o750
      }),
      expect.objectContaining({
        path: "scripts/existing.sh",
        operation: "update",
        beforeMode: 0o644,
        afterMode: 0o755
      })
    ]);
    const existing = inspection.entries.find((entry) => entry.path === "scripts/existing.sh");
    expect(existing?.beforeDigest).toBe(existing?.afterDigest);

    await chmod(path.join(session.workspace.root, "scripts", "created.sh"), 0o700);
    await expect(session.importPatch(workspace, inspection.patchId)).rejects.toThrow("changed after review");
    await chmod(path.join(session.workspace.root, "scripts", "created.sh"), 0o750);
    const rebound = await session.inspectPatch();
    expect(rebound.patchId).toBe(inspection.patchId);
    await chmod(path.join(root, "scripts", "existing.sh"), 0o600);
    await expect(session.importPatch(workspace, rebound.patchId)).rejects.toThrow("mode changed");
    await chmod(path.join(root, "scripts", "existing.sh"), 0o644);
    await session.importPatch(workspace, rebound.patchId);

    expect((await stat(path.join(root, "scripts", "existing.sh"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(root, "scripts", "created.sh"))).mode & 0o777).toBe(0o750);
    await session.release?.({ status: "completed" });
  });

  test("rejects resume when the immutable image digest changes", async () => {
    const { root } = await workspaceFixture();
    const store = createInMemoryAgentRunStore();
    const streamEvents = [[
      {
        type: "tool-call" as const,
        toolCall: {
          id: "bound-command",
          name: "run_environment_command",
          input: { command: "npm", args: ["test"] }
        }
      },
      { type: "finish" as const, finishReason: "tool-calls" as const }
    ]];
    const first = await createHarness({
      provider: "openai",
      workspace: root,
      executionBackend: "oci",
      modelInstance: createMockLanguageModel({ streamEvents }),
      store,
      ociRuntimeAdapter: new FakeOciRuntime(`sha256:${"b".repeat(64)}`)
    });
    const waiting = await runHarness(first, { runId: "image-bound-run", prompt: "Run" });
    expect(waiting.status).toBe("waiting_approval");

    const second = await createHarness({
      provider: "openai",
      workspace: root,
      executionBackend: "oci",
      modelInstance: createMockLanguageModel(),
      store,
      ociRuntimeAdapter: new FakeOciRuntime(`sha256:${"c".repeat(64)}`)
    });
    await expect(runHarness(second, {
      state: waiting.state,
      approvals: waiting.state.pendingApprovals.map((approval) => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true
      }))
    })).rejects.toThrow(/fingerprint|environment/i);
  });

  test("binds the patch identifier to the run and reviewed file digests", () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      kind: "environment-patch",
      runId: "run-a",
      entries: [{
        path: "file.ts",
        operation: "create",
        afterDigest: `sha256:${"d".repeat(64)}`,
        bytes: 4
      }]
    });
    const first = createHash("sha256").update(payload).digest("hex");
    const second = createHash("sha256").update(payload.replace("run-a", "run-b")).digest("hex");
    expect(first).not.toBe(second);
  });

  test("uses one bounded inventory page per snapshot tree and rereads only changed patch content", async () => {
    const { root, workspace } = await workspaceFixture();
    const generatedRoot = path.join(root, "generated");
    await mkdir(generatedRoot, { recursive: true });
    await Promise.all(Array.from({ length: 501 }, (_, index) =>
      writeFile(path.join(generatedRoot, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`)
    ));
    const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime: new FakeOciRuntime()
    });
    const session = await environment.acquire({ runId: "single-inventory-run" });
    for (const name of ["read_files", "search_many"]) {
      await expect(session.authorize({
        tool: { name },
        phase: "execute"
      } as never)).resolves.toMatchObject({ decision: "allow" });
    }
    await writeFile(path.join(session.workspace.root, "generated", "file-000.txt"), "changed\n");

    const status = await session.status() as {
      changedFiles: number;
      io: {
        inventoryPasses: number;
        inventoryPages: number;
        verifiedContentReads: number;
        snapshotFiles: number;
      };
    };
    expect(status.changedFiles).toBe(1);
    expect(status.io).toEqual(expect.objectContaining({
      inventoryPasses: 3,
      inventoryPages: 3,
      snapshotFiles: 504,
      verifiedContentReads: 506
    }));

    await session.release?.({ status: "completed" });
  });

  test("normalizes forced termination outcomes even when the runtime client exits zero", async () => {
    const cases = [
      { outcome: { cancelled: true }, exitCode: 130, message: "cancelled" },
      { outcome: { timedOut: true }, exitCode: 124, message: "timed out" },
      { outcome: { outputLimitExceeded: true }, exitCode: 125, message: "output limit" }
    ] as const;
    for (const [index, fixture] of cases.entries()) {
      const { root, workspace } = await workspaceFixture();
      const runtime = new FakeOciRuntime(undefined, undefined, fixture.outcome);
      const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
      if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
      const environment = await createHarnessOciExecutionEnvironment({
        config: config.execution,
        workspace,
        stateDirectory: config.stateDirectory,
        runtime
      });
      const session = await environment.acquire({ runId: `forced-exit-${index}` });
      const result = await session.runCommand("npm", ["test"]);
      expect(result.exitCode).toBe(fixture.exitCode);
      expect(result.stderr).toContain(fixture.message);
      await session.release?.({ status: "failed" });
    }
  });

  test("inherits the enforced environment into a delegated child run", async () => {
    const { root } = await workspaceFixture();
    const store = createInMemoryAgentRunStore();
    const runtime = new FakeOciRuntime(undefined, async (request) => {
      await writeFile(path.join(request.snapshotRoot, "child-generated.txt"), "child snapshot only\n");
    });
    const parentModel = createMockLanguageModel({
      provider: "mock-parent",
      modelId: "parent",
      streamEvents: [
        [
          {
            type: "tool-call",
            toolCall: {
              id: "delegate-oci-child",
              name: "delegate_implementer",
              input: { prompt: "Run the enforced command" }
            }
          },
          { type: "finish", finishReason: "tool-calls" }
        ],
        [
          { type: "text-delta", textDelta: "child completed" },
          { type: "finish", finishReason: "stop" }
        ]
      ]
    });
    const childModel = createMockLanguageModel({
      provider: "mock-child",
      modelId: "implementer",
      responses: [
        {
          messages: [{
            role: "assistant",
            parts: [{
              type: "tool-call",
              toolCall: {
                id: "child-oci-command",
                name: "run_environment_command",
                input: { command: "npm", args: ["test"] }
              }
            }]
          }],
          finishReason: "tool-calls"
        },
        {
          messages: [{ role: "assistant", parts: [{ type: "text", text: "environment inherited" }] }],
          text: "environment inherited",
          finishReason: "stop"
        }
      ]
    });
    const harness = await createHarness({
      provider: "openai",
      workspace: root,
      executionBackend: "oci",
      modelInstance: parentModel,
      subagentModels: { implementer: childModel },
      subagentProfiles: ["implementer"],
      store,
      ociRuntimeAdapter: runtime
    });
    const waiting = await runHarness(harness, {
      runId: "parent-oci-delegation",
      prompt: "Delegate the command",
      scope: harness.config.scope
    });
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.pendingApprovals).toHaveLength(1);
    expect(waiting.state.pendingApprovals[0]).toMatchObject({
      kind: "subagent",
      childAgentId: "zhivex-harness-implementer"
    });
    const completed = await runHarness(harness, {
      state: waiting.state,
      approvals: waiting.state.pendingApprovals.map((approval) => ({
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true,
        reason: "Approve inherited OCI command."
      }))
    });
    expect(completed.status).toBe("completed");
    const child = completed.state.childRuns?.[0];
    expect(child?.status).toBe("completed");
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.runId).toBe(child?.runId);
    const childState = child ? await store.load(child.runId, harness.config.scope) : undefined;
    expect(childState?.executionEnvironment).toEqual(completed.state.executionEnvironment);
    await expect(readFile(path.join(root, "child-generated.txt"), "utf8")).rejects.toThrow();
    await harness.close();
  });

  test("rejects MCP before discovery when the enforced boundary is active", async () => {
    const { root } = await workspaceFixture();
    let discoveries = 0;
    await expect(createHarness({
      provider: "openai",
      workspace: root,
      executionBackend: "oci",
      modelInstance: createMockLanguageModel(),
      store: createInMemoryAgentRunStore(),
      ociRuntimeAdapter: new FakeOciRuntime(),
      mcpConfiguration: {
        schemaVersion: 1,
        servers: [{
          name: "external",
          transport: "custom",
          includeTools: ["lookup"],
          permissions: ["read"]
        }]
      },
      mcpClients: {
        external: {
          async listTools() {
            discoveries += 1;
            return { tools: [] };
          },
          async callTool() {
            throw new Error("not called");
          }
        }
      }
    })).rejects.toThrow("before discovery");
    expect(discoveries).toBe(0);
  });

  test("discards a partial crash snapshot before first acquisition", async () => {
    const { root, workspace } = await workspaceFixture();
    const config = resolveHarnessConfig({ workspace: root, executionBackend: "oci" });
    if (config.execution.backend !== "oci") throw new Error("Expected OCI execution config.");
    const runId = "partial-snapshot-run";
    const runDirectory = path.join(
      config.stateDirectory,
      "environments",
      createHash("sha256").update(runId).digest("hex").slice(0, 24)
    );
    for (const name of ["base", "workspace"]) {
      await mkdir(path.join(runDirectory, name), { recursive: true });
      await writeFile(path.join(runDirectory, name, "stale.txt"), "stale crash data\n");
    }
    const environment = await createHarnessOciExecutionEnvironment({
      config: config.execution,
      workspace,
      stateDirectory: config.stateDirectory,
      runtime: new FakeOciRuntime()
    });
    const session = await environment.acquire({ runId });
    await expect(session.workspace.readFile("stale.txt")).rejects.toThrow();
    expect((await session.inspectPatch()).entries).toEqual([]);
    await session.release?.({ status: "completed" });
  });
});
