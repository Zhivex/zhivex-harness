import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  REPRESENTATIVE_EVIDENCE_PROVIDERS,
  REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION,
  representativeEvidenceSchema,
  representativeProviderResultSchema,
  validateRepresentativeEvidence,
  type RepresentativeEvidence
} from "./representative-evidence.js";

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const EXPECTED_RESULT_FILES = REPRESENTATIVE_EVIDENCE_PROVIDERS.map((provider) => `${provider}.json`);

export const representativeEvidenceAssemblyMatrixSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("harness-representative-evaluation-assembly-matrix"),
  releaseTags: representativeEvidenceSchema.shape.releaseTags,
  expectedModels: representativeEvidenceSchema.shape.expectedModels,
  expectedCases: representativeEvidenceSchema.shape.expectedCases
}).strict();

export type RepresentativeEvidenceAssemblyMatrix = z.infer<typeof representativeEvidenceAssemblyMatrixSchema>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Representative evidence assembly failed: ${message}`);
}

export const parseRepresentativeEvidenceAssemblyMatrix = (
  input: unknown
): RepresentativeEvidenceAssemblyMatrix => {
  const matrix = representativeEvidenceAssemblyMatrixSchema.parse(input);
  assert(new Set(matrix.releaseTags).size === matrix.releaseTags.length, "matrix releaseTags contain duplicates");
  const modelPinReleaseTags = matrix.expectedModels.map((pin) => pin.releaseTag);
  assert(
    new Set(modelPinReleaseTags).size === modelPinReleaseTags.length,
    "matrix expectedModels.releaseTag contains duplicates"
  );
  assert(
    matrix.releaseTags.length === modelPinReleaseTags.length &&
      matrix.releaseTags.every((releaseTag) => modelPinReleaseTags.includes(releaseTag)),
    "matrix expectedModels must pin every releaseTag exactly once"
  );
  return matrix;
};

export const assertRepresentativeProviderModelPin = (
  matrix: RepresentativeEvidenceAssemblyMatrix,
  releaseTag: string,
  provider: (typeof REPRESENTATIVE_EVIDENCE_PROVIDERS)[number],
  model: string
) => {
  const pin = matrix.expectedModels.find((entry) => entry.releaseTag === releaseTag);
  assert(pin, `${releaseTag} has no external model pins`);
  assert(pin.models[provider] === model, `${releaseTag}/${provider} model differs from its external pin`);
};

/**
 * Assemble only sanitized provider rows. The expected case inventory comes from
 * an independent matrix and the complete document is revalidated fail-closed.
 */
export const assembleRepresentativeEvidence = (
  releaseTag: string,
  matrixInput: unknown,
  providerInputs: readonly unknown[]
): RepresentativeEvidence => {
  const matrix = parseRepresentativeEvidenceAssemblyMatrix(matrixInput);
  assert(matrix.releaseTags.includes(releaseTag), `${releaseTag} is not declared by the assembly matrix`);
  assert(
    providerInputs.length === REPRESENTATIVE_EVIDENCE_PROVIDERS.length,
    "exactly one meta, qwen, and openai result is required"
  );
  const results = providerInputs.map((input) => representativeProviderResultSchema.parse(input));
  for (const result of results) {
    assertRepresentativeProviderModelPin(matrix, releaseTag, result.provider, result.model);
  }
  const expectedModelPin = matrix.expectedModels.find((pin) => pin.releaseTag === releaseTag)!;
  return validateRepresentativeEvidence({
    schemaVersion: REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION,
    kind: "harness-representative-evaluation-evidence",
    releaseTags: [releaseTag],
    expectedModels: [expectedModelPin],
    expectedCases: matrix.expectedCases,
    results
  }, [releaseTag]);
};

const readBoundedJson = async (filePath: string, label: string) => {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) throw new Error(`${label} must have exactly one regular-file link.`);
    if (entry.size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds ${MAX_INPUT_BYTES} bytes.`);
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await handle.close();
  }
};

export const assembleRepresentativeEvidenceFromFiles = async (
  releaseTag: string,
  matrixPath: string,
  inputDirectory: string
): Promise<RepresentativeEvidence> => {
  const directoryEntry = await lstat(inputDirectory);
  assert(directoryEntry.isDirectory() && !directoryEntry.isSymbolicLink(), "--input-dir must be a non-symlink directory");
  const canonicalDirectory = await realpath(inputDirectory);
  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  const entryNames = entries.map((entry) => entry.name).sort();
  assert(
    entryNames.length === EXPECTED_RESULT_FILES.length &&
      EXPECTED_RESULT_FILES.every((name) => entryNames.includes(name)),
    `--input-dir must contain only ${EXPECTED_RESULT_FILES.join(", ")}`
  );
  assert(entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()), "provider inputs must be regular files");

  const matrix = await readBoundedJson(matrixPath, "--matrix");
  const results = await Promise.all(EXPECTED_RESULT_FILES.map((name) =>
    readBoundedJson(path.join(canonicalDirectory, name), name)
  ));
  return assembleRepresentativeEvidence(releaseTag, matrix, results);
};

interface CliOptions {
  releaseTag: string;
  matrixPath: string;
  inputDirectory: string;
}

export const parseRepresentativeEvidenceAssemblerOptions = (args: readonly string[]): CliOptions => {
  const supported = new Map([
    ["--release-tag", "releaseTag"],
    ["--matrix", "matrixPath"],
    ["--input-dir", "inputDirectory"]
  ] as const);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    const field = supported.get(option as typeof supported extends Map<infer K, string> ? K : never);
    if (!field) throw new Error(`Unknown option: ${option}`);
    if (values.has(field)) throw new Error(`${option} cannot be repeated.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    values.set(field, value);
    index += 1;
  }
  for (const [option, field] of supported) {
    if (!values.has(field)) throw new Error(`${option} is required.`);
  }
  return {
    releaseTag: values.get("releaseTag")!,
    matrixPath: values.get("matrixPath")!,
    inputDirectory: values.get("inputDirectory")!
  };
};

const main = async () => {
  const options = parseRepresentativeEvidenceAssemblerOptions(process.argv.slice(2));
  const evidence = await assembleRepresentativeEvidenceFromFiles(
    options.releaseTag,
    options.matrixPath,
    options.inputDirectory
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
};

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((error: unknown) => {
    process.stderr.write(`Representative evidence assembly failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
