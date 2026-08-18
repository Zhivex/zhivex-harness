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
        stdout: `${JSON.stringify({ secretExcluded: true, networkDenied: true, snapshotMutation: true })}\n`,
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
});
