import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  HarnessProviderError,
  changeEnvelopeSchema,
  createChangeEnvelope,
  harnessErrorDocument,
  parseCliJsonDocument,
  parseCliJsonLineDocument
} from "../src/index.js";

const fixture = async (name: string) => JSON.parse(await readFile(
  path.join(import.meta.dir, "..", "fixtures", "contracts", "v1", name),
  "utf8"
));

describe("public JSON and JSONL contracts", () => {
  test("parses v1 golden documents and retains additive observational fields", async () => {
    const runResult = await fixture("run-result.json");
    expect(parseCliJsonDocument(runResult)).toMatchObject({
      kind: "run-result",
      runId: "run_fixture"
    });
    expect(parseCliJsonDocument(await fixture("run-result-forward.json"))).toMatchObject({
      additiveEvidence: { format: "future-1.x" }
    });
    expect(parseCliJsonDocument(await fixture("error.json"))).toMatchObject({
      error: { code: "EXECUTION_FAILED" }
    });
    expect(parseCliJsonDocument(await fixture("providers.json"))).toMatchObject({
      kind: "providers",
      providers: [{ id: "openai" }]
    });
    expect(parseCliJsonDocument(await fixture("doctor.json"))).toMatchObject({
      kind: "doctor",
      configSchemaVersion: 5
    });
    expect(parseCliJsonDocument(await fixture("init.json"))).toMatchObject({
      kind: "init",
      profile: { name: "daily", provider: "openai" }
    });
    const documents = await fixture("observational-documents.json") as unknown[];
    expect(documents.map((document) => parseCliJsonDocument(document).kind)).toEqual([
      "review-group",
      "run-list",
      "session-list",
      "change-envelope-verification"
    ]);
    expect(() => parseCliJsonDocument({ schemaVersion: 1, kind: "review-group" })).toThrow();
    expect(() => parseCliJsonDocument({ schemaVersion: 1, kind: "providers", providers: [{}] })).toThrow();
    expect(() => parseCliJsonDocument({
      schemaVersion: 1,
      kind: "doctor",
      ok: true,
      checks: []
    })).toThrow();
    expect(() => parseCliJsonDocument({
      ...runResult,
      budget: {}
    })).toThrow();
  });

  test("uses distinct final-result kinds for JSON and JSONL", async () => {
    const rich = parseCliJsonDocument(await fixture("run-result.json"));
    const line = await readFile(
      path.join(import.meta.dir, "..", "fixtures", "contracts", "v1", "run-stream-result.jsonl"),
      "utf8"
    );
    const streamed = parseCliJsonLineDocument(line.trim());
    expect(rich.kind).toBe("run-result");
    expect(streamed.kind).toBe("run-stream-result");
  });

  test("rejects unknown or structurally incomplete JSONL events and terminal arrays", () => {
    expect(() => parseCliJsonLineDocument({
      schemaVersion: 1,
      kind: "run-event",
      sequence: 1,
      type: "made-up"
    })).toThrow();
    expect(() => parseCliJsonLineDocument({
      schemaVersion: 1,
      kind: "run-event",
      sequence: 1,
      type: "text-delta"
    })).toThrow();
    expect(() => parseCliJsonLineDocument({
      schemaVersion: 1,
      kind: "run-stream-result",
      sequence: 2,
      runId: "run-1",
      status: "completed",
      provider: "openai",
      model: "fixture",
      steps: 1,
      toolCalls: 0,
      pendingApprovals: "invalid",
      children: 0
    })).toThrow();
  });

  test("redacts messages and causes from stable error documents", () => {
    const serialized = JSON.stringify(harnessErrorDocument(new HarnessProviderError(
      "provider-secret",
      { cause: new Error("cause-secret"), retryable: true }
    )));
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("cause-secret");
    expect(JSON.parse(serialized)).toMatchObject({
      error: { code: "PROVIDER_UNAVAILABLE", category: "provider", retryable: true }
    });
  });

  test("keeps digest-bound change envelopes strict", () => {
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const envelope = createChangeEnvelope({
      createdAt: "2026-08-23T12:00:00.000Z",
      base: { workspaceDigest: digest("1"), treeDigest: digest("2") },
      patch: { patchId: "patch-1", patchDigest: digest("3") },
      fingerprints: {
        harness: digest("4"),
        policy: digest("5"),
        environment: digest("6")
      },
      checks: [{
        checkId: "tests",
        status: "passed",
        redacted: true,
        startedAt: "2026-08-23T11:59:00.000Z",
        completedAt: "2026-08-23T11:59:01.000Z",
        durationMs: 1_000,
        exitCode: 0
      }]
    });
    expect(parseCliJsonDocument(envelope)).toEqual(envelope);
    expect(changeEnvelopeSchema.safeParse({ ...envelope, unsignedExtra: true }).success).toBe(false);
    expect(() => parseCliJsonDocument({ ...envelope, unsignedExtra: true })).toThrow();
  });
});
