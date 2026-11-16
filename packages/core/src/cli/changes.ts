import path from "node:path";
import {
  canonicalizeChangeEnvelope,
  changeEnvelopePreconditionsSchema,
  createChangeEnvelope,
  digestChangeEnvelopeArtifact,
  verifyChangeEnvelope,
  type ChangeEnvelopePreconditions
} from "../workspace/change-envelope.js";
import {
  FileChangedWhileReadingError,
  FileSizeLimitError,
  readRegularFileNoFollow,
  UnsafeFileTypeError
} from "../workspace/file-security.js";
import { CliUsageError, type CliOptions } from "./arguments.js";
import { CLI_EXIT_CODES } from "./errors.js";

const MAX_CHANGE_ENVELOPE_JSON_BYTES = 4 * 1024 * 1024;

const MAX_CHANGE_ARTIFACT_BYTES = 64 * 1024 * 1024;

const readStableCliArtifact = async (filePath: string, maxBytes: number) => {
  const absolute = path.resolve(process.cwd(), filePath);
  try {
    return (await readRegularFileNoFollow(absolute, {
      label: `Change artifact ${filePath}`,
      maxBytes
    })).contents;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    if (error instanceof UnsafeFileTypeError) {
      throw new CliUsageError(`Change artifact must be a regular non-symlink file: ${filePath}`);
    }
    if (error instanceof FileSizeLimitError) {
      throw new CliUsageError(`Change artifact exceeds the ${maxBytes}-byte limit: ${filePath}`);
    }
    if (error instanceof FileChangedWhileReadingError) {
      throw new CliUsageError(`Change artifact changed while it was being read: ${filePath}`);
    }
    const code = error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (typeof code === "string") {
      throw new CliUsageError(`Change artifact cannot be read (${code}): ${filePath}`);
    }
    throw error;
  }
};

const readCliJsonArtifact = async (filePath: string): Promise<unknown> => {
  const contents = await readStableCliArtifact(filePath, MAX_CHANGE_ENVELOPE_JSON_BYTES);
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new CliUsageError(`Change artifact is not valid JSON: ${filePath}`);
  }
};

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliUsageError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
};

export const manageChanges = async (options: CliOptions) => {
  if (!options.changesCommand || !options.artifactPath || !options.patchPath) {
    throw new CliUsageError("Incomplete changes command.");
  }
  const patchBytes = await readStableCliArtifact(options.patchPath, MAX_CHANGE_ARTIFACT_BYTES);
  const patchDigest = digestChangeEnvelopeArtifact(patchBytes);

  if (options.changesCommand === "create") {
    const input = objectValue(await readCliJsonArtifact(options.artifactPath), "Change envelope input");
    const patchInput = objectValue(input.patch, "Change envelope patch");
    if (patchInput.patchDigest !== undefined && patchInput.patchDigest !== patchDigest) {
      throw new CliUsageError("The declared patch.patchDigest does not match the exact --patch bytes.");
    }
    const envelope = createChangeEnvelope({
      ...input,
      patch: { ...patchInput, patchDigest }
    });
    process.stdout.write(`${canonicalizeChangeEnvelope(envelope)}\n`);
    return;
  }

  const envelope = await readCliJsonArtifact(options.artifactPath);
  const suppliedPreconditions = options.preconditionsPath
    ? objectValue(await readCliJsonArtifact(options.preconditionsPath), "Change envelope preconditions")
    : {};
  if (suppliedPreconditions.patchDigest !== undefined && suppliedPreconditions.patchDigest !== patchDigest) {
    throw new CliUsageError("The precondition patchDigest does not match the exact --patch bytes.");
  }
  const preconditions: ChangeEnvelopePreconditions = changeEnvelopePreconditionsSchema.parse({
    ...suppliedPreconditions,
    patchDigest
  });
  const result = verifyChangeEnvelope(envelope, {
    ...(options.verificationTime ? { now: options.verificationTime } : {}),
    preconditions
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "change-envelope-verification",
    ...result
  })}\n`);
  if (!result.valid) process.exitCode = CLI_EXIT_CODES.runtimeError;
};
