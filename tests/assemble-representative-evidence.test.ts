import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleRepresentativeEvidence,
  assembleRepresentativeEvidenceFromFiles,
  parseRepresentativeEvidenceAssemblerOptions
} from "../scripts/assemble-representative-evidence.js";
import {
  REPRESENTATIVE_EVIDENCE_PROVIDERS,
  REPRESENTATIVE_EVIDENCE_SCENARIOS
} from "../scripts/representative-evidence.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const expectedCases = REPRESENTATIVE_EVIDENCE_SCENARIOS.map((scenarioId, index) => ({
  caseId: `case-${index + 1}`,
  scenarioId
}));

const matrix = () => ({
  schemaVersion: 1 as const,
  kind: "harness-representative-evaluation-assembly-matrix" as const,
  releaseTags: ["v1.0.0-rc.1", "v1.0.0-rc.2", "v1.0.0"],
  expectedModels: [
    {
      releaseTag: "v1.0.0-rc.1",
      models: { meta: "meta-fixture", qwen: "qwen-fixture", openai: "openai-fixture" }
    },
    {
      releaseTag: "v1.0.0-rc.2",
      models: { meta: "meta-corrected", qwen: "qwen-corrected", openai: "openai-corrected" }
    },
    {
      releaseTag: "v1.0.0",
      models: { meta: "meta-fixture", qwen: "qwen-fixture", openai: "openai-fixture" }
    }
  ],
  expectedCases
});

const providerResult = (provider: (typeof REPRESENTATIVE_EVIDENCE_PROVIDERS)[number]) => ({
  releaseTag: "v1.0.0-rc.1",
  sourceCommit: "a".repeat(40),
  artifactSha512: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  datasetRevision: "representative-repositories-v1",
  driverCommit: "d".repeat(40),
  ociImageDigest: `sha256:${"e".repeat(64)}`,
  workflowRunUrl: "https://github.com/Zhivex/zhivex-harness/actions/runs/32195816001",
  provider,
  model: `${provider}-fixture`,
  observedAt: "2026-08-23T12:00:30.000Z",
  cases: expectedCases.map((entry, index) => ({
    ...entry,
    runId: `${provider}-run-${index + 1}`,
    status: "passed" as const,
    startedAt: `2026-08-23T12:00:${String(index).padStart(2, "0")}.000Z`,
    completedAt: `2026-08-23T12:00:${String(index).padStart(2, "0")}.250Z`,
    durationMs: 250
  })),
  totalRuns: 7,
  passedRuns: 7,
  failedRuns: 0,
  omittedRuns: 0
});

const rows = () => REPRESENTATIVE_EVIDENCE_PROVIDERS.map(providerResult);

describe("representative evidence assembler", () => {
  test("combines exactly the sanitized provider cohort using external expected cases", () => {
    const evidence = assembleRepresentativeEvidence("v1.0.0-rc.1", matrix(), rows());

    expect(evidence.expectedCases).toEqual(expectedCases);
    expect(evidence.expectedModels).toEqual([matrix().expectedModels[0]]);
    expect(evidence.results.map((entry) => entry.provider)).toEqual([...REPRESENTATIVE_EVIDENCE_PROVIDERS]);
    expect(JSON.stringify(evidence)).not.toContain("prompt");
  });

  test("assembles the exact stable tag instead of blocking the 1.0.0 publish job", () => {
    const stableRows = rows().map((row) => ({ ...row, releaseTag: "v1.0.0" }));
    const evidence = assembleRepresentativeEvidence("v1.0.0", matrix(), stableRows);

    expect(evidence.releaseTags).toEqual(["v1.0.0"]);
    expect(evidence.expectedModels).toEqual([matrix().expectedModels[2]]);
  });

  test("rejects missing and extra provider rows before assembly", () => {
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.1", matrix(), rows().slice(1)))
      .toThrow("exactly one meta, qwen, and openai");
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.1", matrix(), [...rows(), rows()[0]]))
      .toThrow("exactly one meta, qwen, and openai");
  });

  test("rejects undeclared RCs, extra keys, and raw provider fields", () => {
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.3", matrix(), rows()))
      .toThrow("is not declared by the assembly matrix");
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.1", { ...matrix(), sourcePath: "/raw" }, rows()))
      .toThrow();
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.1", matrix(), [
      { ...rows()[0]!, rawOutput: "secret" },
      ...rows().slice(1)
    ])).toThrow();
  });

  test("rejects self-declared models and incomplete external pin inventories", () => {
    const substituted = rows();
    substituted[1]!.model = "qwen-substituted";
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.1", matrix(), substituted))
      .toThrow("model differs from its external pin");

    const incomplete = matrix();
    incomplete.expectedModels = incomplete.expectedModels.slice(0, 1);
    expect(() => assembleRepresentativeEvidence("v1.0.0-rc.1", incomplete, rows()))
      .toThrow("must pin every releaseTag exactly once");
  });

  test("requires exactly the three named files and never writes an assembled artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "representative-assembly-"));
    temporaryDirectories.push(root);
    const inputDirectory = path.join(root, "inputs");
    await Bun.write(path.join(root, "matrix.json"), JSON.stringify(matrix()));
    await Bun.write(path.join(inputDirectory, ".keep"), "");
    await rm(path.join(inputDirectory, ".keep"));
    for (const row of rows()) {
      await writeFile(path.join(inputDirectory, `${row.provider}.json`), JSON.stringify(row), "utf8");
    }

    const assembled = await assembleRepresentativeEvidenceFromFiles(
      "v1.0.0-rc.1",
      path.join(root, "matrix.json"),
      inputDirectory
    );
    expect(assembled.results).toHaveLength(3);
    expect((await Array.fromAsync(new Bun.Glob("*.json").scan(inputDirectory))).sort()).toEqual([
      "meta.json", "openai.json", "qwen.json"
    ]);

    await writeFile(path.join(inputDirectory, "raw-report.json"), "{}", "utf8");
    await expect(assembleRepresentativeEvidenceFromFiles(
      "v1.0.0-rc.1",
      path.join(root, "matrix.json"),
      inputDirectory
    )).rejects.toThrow("must contain only");
  });

  test("fails closed when one named provider file is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "representative-assembly-missing-"));
    temporaryDirectories.push(root);
    const inputDirectory = path.join(root, "inputs");
    await Bun.write(path.join(root, "matrix.json"), JSON.stringify(matrix()));
    await Bun.write(path.join(inputDirectory, "meta.json"), JSON.stringify(rows()[0]));
    await Bun.write(path.join(inputDirectory, "openai.json"), JSON.stringify(rows()[2]));

    await expect(assembleRepresentativeEvidenceFromFiles(
      "v1.0.0-rc.1",
      path.join(root, "matrix.json"),
      inputDirectory
    )).rejects.toThrow("must contain only");
  });

  test("requires each CLI option exactly once", () => {
    expect(parseRepresentativeEvidenceAssemblerOptions([
      "--release-tag", "v1.0.0-rc.1",
      "--matrix", "matrix.json",
      "--input-dir", "rows"
    ])).toEqual({
      releaseTag: "v1.0.0-rc.1",
      matrixPath: "matrix.json",
      inputDirectory: "rows"
    });
    expect(() => parseRepresentativeEvidenceAssemblerOptions([
      "--release-tag", "v1.0.0-rc.1",
      "--matrix", "matrix.json"
    ])).toThrow("--input-dir is required");
    expect(() => parseRepresentativeEvidenceAssemblerOptions(["--output", "evidence.json"]))
      .toThrow("Unknown option");
  });
});
