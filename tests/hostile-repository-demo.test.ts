import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  HarnessOciRuntimeAdapter,
  OciRunRequest
} from "../src/execution-environment.js";
import {
  HOSTILE_DEMO_COMMAND,
  STALE_DEMO_COMMAND,
  runHostileRepositoryDemo
} from "../scripts/hostile-repository-demo.js";

class DemoRuntime implements HarnessOciRuntimeAdapter {
  readonly requests: OciRunRequest[] = [];
  readonly image = {
    runtime: "docker" as const,
    runtimeVersion: "demo-fixture-1.0.0",
    imageReference: "fixture/bun:1.3.7",
    imageId: `sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`
  };

  constructor(private readonly boundaryEvidence = {
    secretExcluded: true,
    networkDenied: true
  }) {}

  async inspectImage(imageReference: string) {
    return { ...this.image, imageReference };
  }

  async run(request: OciRunRequest) {
    this.requests.push(request);
    const source = request.command.at(-1);
    if (source === HOSTILE_DEMO_COMMAND) {
      await writeFile(
        path.join(request.snapshotRoot, "src", "payment.ts"),
        "export const paymentStatus = \"reviewed\";\n"
      );
      return {
        command: request.command,
        exitCode: 0,
        stdout: `${JSON.stringify({ ...this.boundaryEvidence, snapshotMutation: true })}\n`,
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false
      };
    }
    if (source === STALE_DEMO_COMMAND) {
      await writeFile(
        path.join(request.snapshotRoot, "src", "payment.ts"),
        "export const paymentStatus = \"stale-candidate\";\n"
      );
      return {
        command: request.command,
        exitCode: 0,
        stdout: `${JSON.stringify({ snapshotMutation: true, scenario: "stale-host" })}\n`,
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false
      };
    }
    throw new Error(`Unexpected demo command: ${source}`);
  }

  async removeRunContainers() {
    return 0;
  }

  async cleanupOrphans() {
    return 0;
  }
}

describe("hostile repository demo", () => {
  test("proves durable approvals, isolated execution, redaction, and stale-host rejection", async () => {
    const runtime = new DemoRuntime();
    const result = await runHostileRepositoryDemo({ runtime });

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "hostile-repository-demo",
      ok: true,
      approvals: ["run_environment_command", "apply_environment_patch"],
      persistenceReopens: 2,
      secretExcluded: true,
      networkDenied: true,
      hostUnchangedUntilApprovedImport: true,
      exactlyOnceJournal: true,
      staleHostImportBlocked: true,
      redactedLedger: true
    });
    expect(runtime.requests).toHaveLength(2);
  });

  test("rejects injected runtime output that does not prove both boundaries", async () => {
    const runtime = new DemoRuntime({ secretExcluded: false, networkDenied: false });

    await expect(runHostileRepositoryDemo({ runtime })).rejects.toThrow(
      "Hostile-repository command evidence must report secretExcluded=true"
    );
  });

  test("honors OCI resource limits configured through the environment", async () => {
    const configured = {
      ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS: "5000",
      ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES: "4096",
      ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB: "128",
      ZHIVEX_HARNESS_OCI_MAX_PIDS: "16",
      ZHIVEX_HARNESS_OCI_MAX_CPUS: "2",
      ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES: String(2 * 1024 * 1024),
      ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES: String(64 * 1024),
      ZHIVEX_HARNESS_OCI_TMPFS_MB: "32"
    };
    const previous = Object.fromEntries(
      Object.keys(configured).map((name) => [name, process.env[name]])
    );
    Object.assign(process.env, configured);
    try {
      const runtime = new DemoRuntime();
      await runHostileRepositoryDemo({ runtime });

      expect(runtime.requests).toHaveLength(2);
      for (const request of runtime.requests) {
        expect(request.limits).toEqual({
          maxProcessRuntimeMs: 5_000,
          maxProcessOutputBytes: 4_096,
          maxMemoryMb: 128,
          maxPids: 16,
          maxCpus: 2,
          maxWorkspaceBytes: 2 * 1024 * 1024,
          maxFileWriteBytes: 64 * 1024,
          tmpfsMb: 32
        });
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
