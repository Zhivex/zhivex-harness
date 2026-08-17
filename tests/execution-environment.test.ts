import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";

import { resolveHarnessConfig } from "../src/config.js";
import {
  cleanupHarnessExecutionArtifacts,
  createHarnessOciExecutionEnvironment,
  type HarnessOciRuntimeAdapter,
  type OciCommandResult,
  type OciImageInspection,
  type OciRunRequest
} from "../src/execution-environment.js";
import { createHarness, runHarness } from "../src/harness.js";
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
      imageReference: "fixture/bun:1.3.7",
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

const workspaceFixture = async () => {
  const root = await temporaryDirectory("zhivex-harness-oci-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "oci-fixture",
    private: true,
    scripts: { test: "bun test" }
  }, null, 2));
  await writeFile(path.join(root, "src", "update.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "src", "delete.ts"), "delete me\n");
  await writeFile(path.join(root, ".env"), "SECRET_VALUE=must-not-enter-snapshot\n");
  return { root, workspace: await Workspace.open(root) };
};

describe("enforced OCI execution environment", () => {
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
    await session.runCommand("bun", ["test"]);
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
      command: ["bun", "test"],
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
              input: { command: "bun", args: ["test"] }
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

  test("rejects resume when the immutable image digest changes", async () => {
    const { root } = await workspaceFixture();
    const store = createInMemoryAgentRunStore();
    const streamEvents = [[
      {
        type: "tool-call" as const,
        toolCall: {
          id: "bound-command",
          name: "run_environment_command",
          input: { command: "bun", args: ["test"] }
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
      const result = await session.runCommand("bun", ["test"]);
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
                input: { command: "bun", args: ["test"] }
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
    harness.close();
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
