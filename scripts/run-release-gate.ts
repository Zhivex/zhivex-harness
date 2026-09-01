import path from "node:path";

import {
  parseSanitizedOperationalError,
  releaseWorkflowDiagnosticBindingFromEnv,
  sanitizeOperationalError,
  writeLiveGateDiagnostic
} from "./release-diagnostics.js";

const MAX_CAPTURE_BYTES = 1_000_000;

const parseArguments = (args: readonly string[]) => {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new Error("run-release-gate requires a command after --.");
  }
  let gate: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < separator; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (!value || value === "--" || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--gate") gate = value;
    else if (argument === "--out") out = path.resolve(value);
    else throw new Error(`Unknown argument ${argument}.`);
    index += 1;
  }
  if (!gate || !/^[a-z][a-z0-9-]{0,63}$/.test(gate)) throw new Error("--gate is invalid.");
  if (!out) throw new Error("--out is required.");
  return { gate, out, command: args.slice(separator + 1) };
};

const boundedCapture = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const captured: Uint8Array[] = [];
  let capturedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (capturedBytes < MAX_CAPTURE_BYTES) {
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
      captured.push(chunk);
      capturedBytes += chunk.byteLength;
    }
  }
  return new TextDecoder().decode(Buffer.concat(captured.map((chunk) => Buffer.from(chunk))));
};

const parsedJson = (source: string) => {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

interface ProviderOutcome {
  provider?: string;
  status: "passed" | "failed";
  error?: ReturnType<typeof sanitizeOperationalError>;
}

const safeProvider = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : undefined;

const collectProviderOutcomes = (value: unknown, outcomes: Map<string, ProviderOutcome>) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectProviderOutcomes(entry, outcomes);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const provider = safeProvider(record.provider);
  if (provider && typeof record.ok === "boolean") {
    if (record.ok) {
      outcomes.set(provider, { provider, status: "passed" });
    } else {
      let error: ReturnType<typeof sanitizeOperationalError>;
      try {
        error = parseSanitizedOperationalError(record.error);
      } catch {
        error = sanitizeOperationalError(new Error("Provider gate failed without a valid diagnostic."));
      }
      outcomes.set(provider, { provider, status: "failed", error });
    }
  }
  for (const entry of Object.values(record)) collectProviderOutcomes(entry, outcomes);
};

const firstSanitizedFailure = (value: unknown): ReturnType<typeof sanitizeOperationalError> | undefined => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const failure = firstSanitizedFailure(entry);
      if (failure) return failure;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.error !== undefined) {
    try {
      return parseSanitizedOperationalError(record.error);
    } catch {
      // Only the strict sanitized operational-error projection is accepted.
    }
  }
  for (const entry of Object.values(record)) {
    const failure = firstSanitizedFailure(entry);
    if (failure) return failure;
  }
  return undefined;
};

if (import.meta.main) {
  let options: ReturnType<typeof parseArguments> | undefined;
  try {
    options = parseArguments(process.argv.slice(2));
    const binding = releaseWorkflowDiagnosticBindingFromEnv(process.env);
    if (!binding) throw new Error("Release gate diagnostics require immutable workflow binding.");
    const child = Bun.spawn(options.command, {
      cwd: path.resolve(import.meta.dir, ".."),
      env: process.env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedCapture(child.stdout),
      boundedCapture(child.stderr),
      child.exited
    ]);
    const stdoutValue = parsedJson(stdout);
    const stderrValue = parsedJson(stderr);
    const providerOutcomes = new Map<string, ProviderOutcome>();
    collectProviderOutcomes(stdoutValue, providerOutcomes);
    collectProviderOutcomes(stderrValue, providerOutcomes);
    const outcomes = [...providerOutcomes.values()];
    const providerFailed = outcomes.some((outcome) => outcome.status === "failed");
    if (outcomes.length === 0) {
      outcomes.push(exitCode === 0
        ? { status: "passed" }
        : {
            status: "failed",
            error: firstSanitizedFailure(stdoutValue) ?? firstSanitizedFailure(stderrValue) ??
              sanitizeOperationalError(new Error("Release certification gate failed."))
          });
    } else if (exitCode !== 0 && !providerFailed) {
      outcomes.push({
        status: "failed",
        error: firstSanitizedFailure(stdoutValue) ?? firstSanitizedFailure(stderrValue) ??
          sanitizeOperationalError(new Error("Release certification gate failed."))
      });
    }
    const failed = exitCode !== 0 || outcomes.some((outcome) => outcome.status === "failed");
    await writeLiveGateDiagnostic({
      out: options.out,
      binding,
      gate: options.gate,
      status: failed ? "failed" : "passed",
      outcomes
    });
    process.stdout.write(`Release gate ${options.gate} ${failed ? "failed" : "passed"} with ` +
      `${outcomes.length} sanitized outcome(s).\n`);
    if (failed) process.exitCode = exitCode || 1;
  } catch (error) {
    process.stderr.write("Release gate diagnostic wrapper failed closed.\n");
    if (options) {
      const binding = releaseWorkflowDiagnosticBindingFromEnv(process.env);
      if (binding) {
        await writeLiveGateDiagnostic({
          out: options.out,
          binding,
          gate: options.gate,
          status: "failed",
          outcomes: [{ status: "failed", error: sanitizeOperationalError(error) }]
        }).catch(() => undefined);
      }
    }
    process.exitCode = 1;
  }
}
