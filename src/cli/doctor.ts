import { CliCredentials, type CredentialStatus } from "./cli-credentials.js";
import { sanitizeTerminalText } from "./terminal/terminal-ui.js";
import { constants as fsConstants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { providerAvailability, resolveHarnessConfig, type HarnessProvider } from "../runtime/config.js";
import { loadHarnessMcpConfiguration } from "../integrations/mcp.js";
import { BUN_ENGINE_RANGE, HARNESS_VERSION, NODE_ENGINE_RANGE } from "../version.js";
import { resolvePackageManager } from "../execution/package-manager.js";
import { CliOciRuntimeAdapter, type HarnessOciRuntimeAdapter } from "../execution/execution-environment.js";
import { CLI_JSON_SCHEMA_VERSION } from "./cli-stream.js";
import { readRegularFileNoFollow } from "../workspace/file-security.js";
import { runPortableProcess } from "../execution/process-runtime.js";
import { SqliteDatabase } from "../persistence/sqlite-database.js";
import { DEFAULT_HARNESS_CONTEXT_MANIFEST, loadHarnessProjectContext } from "../context/context-engineering.js";
import { Workspace } from "../workspace/workspace.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details: Record<string, boolean | number | string | readonly string[]>;
}

import { type CliOptions } from "./arguments.js";
import { CLI_EXIT_CODES } from "./errors.js";

export interface DoctorReport {
  schemaVersion: typeof CLI_JSON_SCHEMA_VERSION;
  kind: "doctor";
  ok: boolean;
  harnessVersion: string;
  configSchemaVersion: number;
  configuration: {
    provider: HarnessProvider;
    model: string;
    workspace: string;
    stateDirectory: string;
    storeBackend: string;
    scope: ReturnType<typeof resolveHarnessConfig>["scope"];
    maxSteps: number;
    timeoutMs: number;
    requireVerifiedDelivery: boolean;
    budget: ReturnType<typeof resolveHarnessConfig>["budget"];
    costBudget?: ReturnType<typeof resolveHarnessConfig>["costBudget"];
    compaction: ReturnType<typeof resolveHarnessConfig>["compaction"];
    allowedChecks: readonly string[];
    requiredCapabilities: ReturnType<typeof resolveHarnessConfig>["requiredCapabilities"];
    orchestration: ReturnType<typeof resolveHarnessConfig>["orchestration"];
    context: ReturnType<typeof resolveHarnessConfig>["context"];
    execution: ReturnType<typeof resolveHarnessConfig>["execution"];
    mcpConfigPath?: string;
  };
  checks: DoctorCheck[];
  providers: ReturnType<typeof providerAvailability>;
}

export interface DoctorContext {
  env?: NodeJS.ProcessEnv;
  credentialStatus?: CredentialStatus;
  nodeVersion?: string;
  /** @deprecated Test-only compatibility injection for the secondary Bun runtime. */
  bunVersion?: string;
  ociRuntimeAdapter?: HarnessOciRuntimeAdapter;
}

const sensitiveStateSegments = new Set([
  ".git",
  ".env",
  ".npmrc",
  "dist",
  "node_modules",
  "src"
]);

const isSensitiveStateSegment = (segment: string) => {
  const normalized = segment.toLowerCase();
  return sensitiveStateSegments.has(normalized) ||
    normalized.startsWith(".env.") ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx");
};

const parseNumericVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])] as const
    : undefined;
};

const satisfiesEngine = (version: string, range: string) => {
  const minimumMatch = /^>=(\d+\.\d+\.\d+)$/.exec(range.trim());
  const actual = parseNumericVersion(version);
  const minimum = minimumMatch ? parseNumericVersion(minimumMatch[1] ?? "") : undefined;
  if (!actual || !minimum) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }
  return true;
};

const diagnostic = (
  id: string,
  status: DoctorCheckStatus,
  message: string,
  details: DoctorCheck["details"] = {}
): DoctorCheck => ({ id, status, message, details });

const inspectWorkspace = async (workspace: string): Promise<DoctorCheck> => {
  try {
    const workspaceStat = await stat(workspace);
    if (!workspaceStat.isDirectory()) {
      return diagnostic("workspace", "fail", "Workspace is not a directory.", { path: workspace });
    }
    await access(workspace, fsConstants.R_OK);
    return diagnostic("workspace", "pass", "Workspace exists and is readable.", { path: workspace });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return diagnostic("workspace", "fail", "Workspace cannot be read.", { path: workspace, code });
  }
};

const inspectGit = async (workspace: string): Promise<DoctorCheck> => {
  try {
    const versionProcess = await runPortableProcess(["git", "--version"], {
      timeoutMs: 15_000,
      maxOutputCharacters: 4_096,
      stderr: "ignore"
    });
    if (versionProcess.exitCode !== 0) {
      return diagnostic("git", "warn", "Git is unavailable.", { installed: false });
    }

    const repositoryProcess = await runPortableProcess(["git", "-C", workspace, "rev-parse", "--is-inside-work-tree"], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 15_000,
      maxOutputCharacters: 4_096,
      stderr: "ignore"
    });
    const repository = repositoryProcess.exitCode === 0 && repositoryProcess.stdout.trim() === "true";
    return diagnostic(
      "git",
      repository ? "pass" : "warn",
      repository ? "Git is installed and the workspace is a repository." : "Git is installed, but the workspace is not a repository.",
      { installed: true, repository, version: versionProcess.stdout.trim() }
    );
  } catch {
    return diagnostic("git", "warn", "Git is unavailable.", { installed: false });
  }
};

const inspectScripts = async (workspace: string, allowedChecks: readonly string[]): Promise<DoctorCheck> => {
  const packagePath = path.join(workspace, "package.json");
  try {
    const packageFile = await readRegularFileNoFollow(packagePath, {
      label: "package.json",
      maxBytes: 1024 * 1024
    });
    const packageJson = JSON.parse(packageFile.contents.toString("utf8")) as {
      packageManager?: unknown;
      scripts?: unknown;
    };
    const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
      ? packageJson.scripts as Record<string, unknown>
      : {};
    const available = allowedChecks.filter((name) => typeof scripts[name] === "string");
    const missing = allowedChecks.filter((name) => typeof scripts[name] !== "string");
    const packageManager = await resolvePackageManager(workspace, packageJson);
    return diagnostic(
      "scripts",
      available.length > 0 ? "pass" : "warn",
      available.length > 0
        ? `Supported ${packageManager.manager} check scripts were found.`
        : `No supported ${packageManager.manager} check scripts were found.`,
      {
        packageJson: true,
        packageManager: packageManager.manager,
        packageManagerSource: packageManager.source,
        ...(packageManager.evidence ? { packageManagerEvidence: packageManager.evidence } : {}),
        available,
        missing
      }
    );
  } catch (error) {
    const code = error instanceof SyntaxError
      ? "INVALID_JSON"
      : (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return diagnostic("scripts", "warn", "package.json could not be inspected.", {
      packageJson: false,
      available: [],
      code
    });
  }
};

const isInsidePath = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const containsSymlink = async (candidate: string, trustedPrefix?: string) => {
  const parsed = path.parse(candidate);
  const parts = trustedPrefix
    ? path.relative(trustedPrefix, candidate).split(path.sep).filter(Boolean)
    : candidate.slice(parsed.root.length).split(path.sep).filter(Boolean).slice(1);
  let current = trustedPrefix ?? path.join(parsed.root, candidate.slice(parsed.root.length).split(path.sep).filter(Boolean)[0] ?? "");
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
  return false;
};

const nearestExistingPath = async (candidate: string) => {
  let current = candidate;
  for (;;) {
    try {
      return { path: current, stat: await stat(current) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
};

const inspectStateDirectory = async (workspace: string, stateDirectory: string): Promise<DoctorCheck> => {
  if (stateDirectory === workspace) {
    return diagnostic("state-directory", "fail", "State directory cannot be the workspace root.", {
      path: stateDirectory,
      writable: false
    });
  }

  if (isInsidePath(workspace, stateDirectory)) {
    const segments = path.relative(workspace, stateDirectory).split(path.sep).filter(Boolean);
    const sensitiveSegment = segments.find(isSensitiveStateSegment);
    if (sensitiveSegment) {
      return diagnostic("state-directory", "fail", "State directory is inside a sensitive workspace path.", {
        path: stateDirectory,
        sensitiveSegment,
        writable: false
      });
    }
  }

  try {
    const trustedPrefix = isInsidePath(workspace, stateDirectory) ? workspace : undefined;
    if (await containsSymlink(stateDirectory, trustedPrefix)) {
      return diagnostic("state-directory", "fail", "State directory must not resolve through a symbolic link.", {
        path: stateDirectory,
        writable: false
      });
    }
    const existing = await nearestExistingPath(stateDirectory);
    if (!existing.stat.isDirectory()) {
      return diagnostic("state-directory", "fail", "State directory or its nearest existing parent is not a directory.", {
        path: stateDirectory,
        writable: false
      });
    }
    await access(existing.path, fsConstants.R_OK | fsConstants.W_OK);
    return diagnostic("state-directory", "pass", "State directory is safe and writable.", {
      path: stateDirectory,
      exists: existing.path === stateDirectory,
      writable: true
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return diagnostic("state-directory", "fail", "State directory is not writable.", {
      path: stateDirectory,
      writable: false,
      code
    });
  }
};

const inspectOperationsStore = async (
  stateDirectory: string,
  storeBackend: string
): Promise<DoctorCheck> => {
  if (storeBackend === "file") {
    return diagnostic("operations-store", "warn", "Legacy file run store is selected.", {
      backend: storeBackend,
      migrationAvailable: true
    });
  }
  const databasePath = path.join(stateDirectory, "operations.sqlite");
  try {
    const entry = await lstat(databasePath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return diagnostic("operations-store", "fail", "SQLite state path is not a regular file.", {
        backend: storeBackend,
        databasePath,
        safe: false
      });
    }
    const database = new SqliteDatabase(databasePath, { create: false, readonly: true, strict: true });
    try {
      const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check;
      const tables = new Set(database.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      ).all().map((row) => row.name));
      const requiredOperationsTables = [
        "zhivex_agent_runs",
        "zhivex_agent_runs_idempotency",
        "zhivex_agent_runs_parents",
        "zhivex_agent_runs_leases",
        "zhivex_agent_runs_tool_journal",
        "zhivex_agent_memory"
      ];
      const operationsTablesPresent = requiredOperationsTables.filter((table) => tables.has(table));
      const operationsSchema = operationsTablesPresent.length === 0
        ? "not-initialized"
        : operationsTablesPresent.length === requiredOperationsTables.length
          ? 1
          : "unsupported";
      const operationsCompatible = operationsSchema !== "unsupported";
      const sessionVersion = tables.has("zhivex_cli_session_schema")
        ? database.query<{ version: number }, []>(
            "SELECT version FROM zhivex_cli_session_schema WHERE singleton = 1"
          ).get()?.version
        : undefined;
      const sessionCompatible = sessionVersion === undefined || sessionVersion === 1;
      const compatible = integrity === "ok" && operationsCompatible && sessionCompatible;
      return diagnostic(
        "operations-store",
        compatible ? "pass" : "fail",
        compatible
          ? "SQLite durable operations store is integral and schema-compatible."
          : "SQLite durable operations store failed integrity or schema compatibility checks.",
        {
          backend: storeBackend,
          databasePath,
          safe: true,
          integrity: integrity === "ok",
          operationsSchema,
          sessionSchema: sessionVersion ?? "not-initialized",
          compatible
        }
      );
    } finally {
      database.close(false);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return diagnostic("operations-store", "pass", "SQLite durable operations store will be created on first use.", {
        backend: storeBackend,
        databasePath,
        safe: true
      });
    }
    return diagnostic("operations-store", "fail", "SQLite durable operations store could not be inspected.", {
      backend: storeBackend,
      databasePath,
      safe: false,
      code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN"
    });
  }
};

const inspectMcpConfiguration = async (
  workspace: string,
  configPath: string | undefined
): Promise<DoctorCheck> => {
  if (!configPath) {
    return diagnostic("mcp-config", "pass", "No MCP servers are configured.", {
      configured: false,
      servers: 0
    });
  }
  try {
    const configuration = await loadHarnessMcpConfiguration(workspace, configPath);
    return diagnostic("mcp-config", "pass", "Governed MCP configuration is valid.", {
      configured: true,
      servers: configuration.servers.length,
      names: configuration.servers.map((server) => server.name)
    });
  } catch (error) {
    return diagnostic("mcp-config", "fail", "MCP configuration is invalid or unsafe.", {
      configured: true,
      servers: 0,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

const inspectExecutionEnvironment = async (
  execution: ReturnType<typeof resolveHarnessConfig>["execution"],
  runtimeOverride?: HarnessOciRuntimeAdapter
): Promise<DoctorCheck> => {
  if (execution.backend === "none") {
    return diagnostic("execution-environment", "pass", "Enforced OCI execution is disabled; shell-class tools remain unavailable.", {
      backend: "none",
      shellAvailable: false
    });
  }
  try {
    const runtime = runtimeOverride ?? new CliOciRuntimeAdapter(execution.runtime);
    const image = await runtime.inspectImage(execution.image);
    return diagnostic("execution-environment", "pass", "OCI runtime and preloaded image are available.", {
      backend: "oci",
      runtime: image.runtime,
      runtimeVersion: image.runtimeVersion,
      imageReference: image.imageReference,
      imageDigest: image.imageDigest,
      network: "deny",
      shellAvailable: true
    });
  } catch (error) {
    return diagnostic("execution-environment", "fail", "OCI execution was requested, but the runtime or preloaded image is unavailable. Start Docker/Podman, preload the configured immutable image, then rerun zhx doctor; do not disable isolation to bypass this check.", {
      backend: "oci",
      runtime: execution.runtime,
      imageReference: execution.image,
      error: error instanceof Error ? error.message : String(error),
      shellAvailable: false
    });
  }
};

const inspectProjectContext = async (
  config: ReturnType<typeof resolveHarnessConfig>
): Promise<DoctorCheck> => {
  if (!config.context.enabled) {
    return diagnostic("project-context", "pass", "Project context loading is disabled.", {
      enabled: false,
      sources: 0,
      skills: 0
    });
  }
  try {
    const workspace = await Workspace.open(config.workspace);
    const manifestPath = path.relative(config.workspace, config.context.configPath)
      .split(path.sep)
      .join("/");
    const bundle = await loadHarnessProjectContext(workspace, {
      manifestPath,
      requireManifest: manifestPath !== DEFAULT_HARNESS_CONTEXT_MANIFEST
    });
    return diagnostic("project-context", "pass", "Project context is valid and readable.", {
      enabled: true,
      manifestConfigured: bundle.manifest !== undefined,
      sources: bundle.sources.length,
      skills: bundle.skills.length
    });
  } catch (error) {
    return diagnostic("project-context", "fail", "Project context cannot be loaded.", {
      enabled: true,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

export const createDoctorReport = async (
  options: Pick<
    CliOptions,
    | "provider"
    | "model"
    | "workspace"
    | "stateDirectory"
    | "storeBackend"
    | "tenantId"
    | "userId"
    | "namespace"
    | "maxSteps"
    | "requireVerifiedDelivery"
    | "timeoutMs"
    | "maxToolCalls"
    | "maxToolErrors"
    | "unlimitedTokens"
    | "maxInputTokens"
    | "maxOutputTokens"
    | "maxTotalTokens"
    | "maxCostUsd"
    | "inputCostPerMillion"
    | "outputCostPerMillion"
    | "allowedChecks"
    | "requiredCapabilities"
    | "subagentProfiles"
    | "subagentMaxSteps"
    | "subagentMaxToolCalls"
    | "subagentMaxToolErrors"
    | "subagentMaxInputTokens"
    | "subagentMaxOutputTokens"
    | "subagentMaxTotalTokens"
    | "subagentTimeoutMs"
    | "maxParallelReviews"
    | "executionBackend"
    | "ociRuntime"
    | "ociImage"
    | "ociAllowedCommands"
    | "ociShellMode"
    | "ociMaxProcessRuntimeMs"
    | "ociMaxProcessOutputBytes"
    | "ociMaxMemoryMb"
    | "ociMaxPids"
    | "ociMaxCpus"
    | "ociMaxWorkspaceBytes"
    | "ociMaxFileWriteBytes"
    | "ociTmpfsMb"
    | "mcpConfigPath"
    | "contextConfigPath"
    | "projectContext"
  > = {},
  context: DoctorContext = {}
): Promise<DoctorReport> => {
  const env = context.env ?? process.env;
  const config = resolveHarnessConfig({
    ...(env.ZHIVEX_HARNESS_PROVIDER ? { provider: env.ZHIVEX_HARNESS_PROVIDER } : {}),
    ...(env.ZHIVEX_HARNESS_MODEL ? { model: env.ZHIVEX_HARNESS_MODEL } : {}),
    ...(env.ZHIVEX_HARNESS_MAX_STEPS
      ? { maxSteps: Number(env.ZHIVEX_HARNESS_MAX_STEPS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_STORE ? { storeBackend: env.ZHIVEX_HARNESS_STORE } : {}),
    ...(env.ZHIVEX_HARNESS_TENANT_ID ? { tenantId: env.ZHIVEX_HARNESS_TENANT_ID } : {}),
    ...(env.ZHIVEX_HARNESS_USER_ID ? { userId: env.ZHIVEX_HARNESS_USER_ID } : {}),
    ...(env.ZHIVEX_HARNESS_NAMESPACE ? { namespace: env.ZHIVEX_HARNESS_NAMESPACE } : {}),
    ...(env.ZHIVEX_HARNESS_TIMEOUT_MS
      ? { timeoutMs: Number(env.ZHIVEX_HARNESS_TIMEOUT_MS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_TOOL_CALLS
      ? { maxToolCalls: Number(env.ZHIVEX_HARNESS_MAX_TOOL_CALLS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_TOOL_ERRORS
      ? { maxToolErrors: Number(env.ZHIVEX_HARNESS_MAX_TOOL_ERRORS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_INPUT_TOKENS
      ? { maxInputTokens: Number(env.ZHIVEX_HARNESS_MAX_INPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS
      ? { maxOutputTokens: Number(env.ZHIVEX_HARNESS_MAX_OUTPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_TOTAL_TOKENS
      ? { maxTotalTokens: Number(env.ZHIVEX_HARNESS_MAX_TOTAL_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_COST_USD
      ? { maxCostUsd: Number(env.ZHIVEX_HARNESS_MAX_COST_USD) }
      : {}),
    ...(env.ZHIVEX_HARNESS_INPUT_COST_PER_MILLION
      ? { inputCostPerMillion: Number(env.ZHIVEX_HARNESS_INPUT_COST_PER_MILLION) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OUTPUT_COST_PER_MILLION
      ? { outputCostPerMillion: Number(env.ZHIVEX_HARNESS_OUTPUT_COST_PER_MILLION) }
      : {}),
    ...(env.ZHIVEX_HARNESS_COMPACTION_MAX_MESSAGES
      ? { compactionMaxMessages: Number(env.ZHIVEX_HARNESS_COMPACTION_MAX_MESSAGES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_COMPACTION_MAX_INPUT_TOKENS
      ? { compactionMaxEstimatedInputTokens: Number(env.ZHIVEX_HARNESS_COMPACTION_MAX_INPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_COMPACTION_KEEP_RECENT
      ? { compactionKeepRecentMessages: Number(env.ZHIVEX_HARNESS_COMPACTION_KEEP_RECENT) }
      : {}),
    ...(env.ZHIVEX_HARNESS_ALLOWED_CHECKS !== undefined
      ? { allowedChecks: env.ZHIVEX_HARNESS_ALLOWED_CHECKS.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_REQUIRED_CAPABILITIES !== undefined
      ? { requiredCapabilities: env.ZHIVEX_HARNESS_REQUIRED_CAPABILITIES.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENTS !== undefined
      ? { subagentProfiles: env.ZHIVEX_HARNESS_SUBAGENTS.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_STEPS
      ? { subagentMaxSteps: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_STEPS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_CALLS
      ? { subagentMaxToolCalls: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_CALLS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_ERRORS
      ? { subagentMaxToolErrors: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOOL_ERRORS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_INPUT_TOKENS
      ? { subagentMaxInputTokens: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_INPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_OUTPUT_TOKENS
      ? { subagentMaxOutputTokens: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_OUTPUT_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOTAL_TOKENS
      ? { subagentMaxTotalTokens: Number(env.ZHIVEX_HARNESS_SUBAGENT_MAX_TOTAL_TOKENS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_SUBAGENT_TIMEOUT_MS
      ? { subagentTimeoutMs: Number(env.ZHIVEX_HARNESS_SUBAGENT_TIMEOUT_MS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_MAX_PARALLEL_REVIEWS
      ? { maxParallelReviews: Number(env.ZHIVEX_HARNESS_MAX_PARALLEL_REVIEWS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_EXECUTION ? { executionBackend: env.ZHIVEX_HARNESS_EXECUTION } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_RUNTIME ? { ociRuntime: env.ZHIVEX_HARNESS_OCI_RUNTIME } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_IMAGE ? { ociImage: env.ZHIVEX_HARNESS_OCI_IMAGE } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS !== undefined
      ? { ociAllowedCommands: env.ZHIVEX_HARNESS_OCI_ALLOWED_COMMANDS.split(",") }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_SHELL ? { ociShellMode: env.ZHIVEX_HARNESS_OCI_SHELL } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS
      ? { ociMaxProcessRuntimeMs: Number(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_RUNTIME_MS) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES
      ? { ociMaxProcessOutputBytes: Number(env.ZHIVEX_HARNESS_OCI_MAX_PROCESS_OUTPUT_BYTES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB
      ? { ociMaxMemoryMb: Number(env.ZHIVEX_HARNESS_OCI_MAX_MEMORY_MB) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_PIDS ? { ociMaxPids: Number(env.ZHIVEX_HARNESS_OCI_MAX_PIDS) } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_CPUS ? { ociMaxCpus: Number(env.ZHIVEX_HARNESS_OCI_MAX_CPUS) } : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES
      ? { ociMaxWorkspaceBytes: Number(env.ZHIVEX_HARNESS_OCI_MAX_WORKSPACE_BYTES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES
      ? { ociMaxFileWriteBytes: Number(env.ZHIVEX_HARNESS_OCI_MAX_FILE_WRITE_BYTES) }
      : {}),
    ...(env.ZHIVEX_HARNESS_OCI_TMPFS_MB ? { ociTmpfsMb: Number(env.ZHIVEX_HARNESS_OCI_TMPFS_MB) } : {}),
    ...(env.ZHIVEX_HARNESS_MCP_CONFIG ? { mcpConfigPath: env.ZHIVEX_HARNESS_MCP_CONFIG } : {}),
    ...(env.ZHIVEX_HARNESS_CONTEXT_CONFIG ? { contextConfigPath: env.ZHIVEX_HARNESS_CONTEXT_CONFIG } : {}),
    ...(env.ZHIVEX_HARNESS_PROJECT_CONTEXT === "0" ? { projectContext: false } : {}),
    ...options
  });
  const runtime = context.nodeVersion
    ? { name: "node" as const, version: context.nodeVersion, required: NODE_ENGINE_RANGE }
    : context.bunVersion
      ? { name: "bun" as const, version: context.bunVersion, required: BUN_ENGINE_RANGE }
      : process.versions.bun
        ? { name: "bun" as const, version: process.versions.bun, required: BUN_ENGINE_RANGE }
        : { name: "node" as const, version: process.versions.node, required: NODE_ENGINE_RANGE };
  const providers = providerAvailability(env);
  const selectedProvider = providers.find((provider) => provider.id === config.provider);
  const checks: DoctorCheck[] = [];

  checks.push(diagnostic(
    runtime.name,
    satisfiesEngine(runtime.version, runtime.required) ? "pass" : "fail",
    satisfiesEngine(runtime.version, runtime.required)
      ? `${runtime.name === "node" ? "Node.js" : "Bun"} satisfies the package engine requirement.`
      : `${runtime.name === "node" ? "Node.js" : "Bun"} does not satisfy the package engine requirement.`,
    { version: runtime.version, required: runtime.required, primary: runtime.name === "node" }
  ));
  checks.push(await inspectWorkspace(config.workspace));
  checks.push(await inspectGit(config.workspace));
  checks.push(await inspectScripts(config.workspace, config.allowedChecks));
  checks.push(await inspectStateDirectory(config.workspace, config.stateDirectory));
  checks.push(await inspectOperationsStore(config.stateDirectory, config.storeBackend));
  checks.push(await inspectProjectContext(config));
  checks.push(await inspectMcpConfiguration(config.workspace, config.mcpConfigPath));
  checks.push(await inspectExecutionEnvironment(config.execution, context.ociRuntimeAdapter));

  for (const provider of providers) {
    const invalidRegion = provider.id === "qwen" && provider.configuration.regionValid === false;
    const invalidEndpoint = !provider.configuration.endpointValid;
    const selected = provider.id === selectedProvider?.id;
    const credential = selected ? context.credentialStatus : undefined;
    const configured = credential?.configured ?? provider.configured;
    const status: DoctorCheckStatus = invalidRegion || invalidEndpoint || !configured
      ? selected
        ? "fail"
        : "warn"
      : provider.support === "provisional"
        ? "warn"
        : "pass";
    const message = invalidEndpoint
      ? `${provider.name} custom endpoint configuration is invalid.`
      : invalidRegion
      ? "Qwen region configuration is invalid."
      : credential
        ? credential.configured
          ? `${provider.name} credential present (${credential.source}); account access has not been checked.${provider.support === "provisional" ? " Live support is provisional." : ""}`
          : credential.source === "blocked"
            ? `${provider.name} managed credentials require the default endpoint. Remove endpoint overrides or provide an environment key.`
            : `${provider.name} credential ${credential.source === "unavailable" ? "could not be checked: keychain unavailable or locked" : "is missing"}. Run zhx to configure a key, or set ${provider.credentialNames.join(" or ")} for automation.`
      : provider.configured
        ? provider.support === "provisional"
          ? `${provider.name} credentials are present, but live support is provisional.`
          : `${provider.name} credentials are present.`
        : `${provider.name} credentials are missing. Set ${provider.credentialNames.join(" or ")} in the environment and rerun zhx doctor.`;
    checks.push(diagnostic(`provider:${provider.id}`, status, message, {
      provider: provider.id,
      selected,
      configured,
      ...(credential ? { credentialSource: credential.source, accountAccess: "not-checked" } : {}),
      support: provider.support,
      credentialNames: provider.credentialNames,
      capabilities: provider.capabilities,
      customEndpoint: provider.configuration.customEndpoint,
      endpointValid: provider.configuration.endpointValid,
      endpointSecure: provider.configuration.endpointSecure,
      ...(provider.id === "qwen"
        ? {
            regionConfigured: provider.configuration.regionConfigured,
            regionValid: provider.configuration.regionValid,
            workspaceIdConfigured: provider.configuration.workspaceIdConfigured
          }
        : {})
    }));
  }

  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    kind: "doctor",
    ok: !checks.some((check) => check.status === "fail"),
    harnessVersion: HARNESS_VERSION,
    configSchemaVersion: config.schemaVersion,
    configuration: {
      provider: config.provider,
      model: config.model,
      workspace: config.workspace,
      stateDirectory: config.stateDirectory,
      storeBackend: config.storeBackend,
      scope: config.scope,
      requireVerifiedDelivery: config.requireVerifiedDelivery,
      maxSteps: config.maxSteps,
      timeoutMs: config.timeoutMs,
      budget: config.budget,
      ...(config.costBudget ? { costBudget: config.costBudget } : {}),
      compaction: config.compaction,
      allowedChecks: config.allowedChecks,
      requiredCapabilities: config.requiredCapabilities,
      orchestration: config.orchestration,
      context: config.context,
      execution: config.execution,
      ...(config.mcpConfigPath ? { mcpConfigPath: config.mcpConfigPath } : {})
    },
    checks,
    providers
  };
};

export const formatDoctorReport = (report: DoctorReport) => {
  const symbols: Record<DoctorCheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };
  const lines = [
    `Zhivex Harness doctor v${report.harnessVersion}`,
    `Provider: ${report.configuration.provider} · Model: ${report.configuration.model}`,
    `Project: ${report.configuration.workspace}`,
    ...report.checks.filter(check => !check.id.startsWith("provider:") || check.details.selected === true).map((check) => `${symbols[check.status]} ${check.id}: ${check.message}`),
    report.ok ? "Doctor completed without blocking problems." : "Doctor found blocking problems."
  ];
  return `${lines.map(line => sanitizeTerminalText(line)).join("\n")}\n`;
};

export const doctor = async (options: CliOptions) => {
  const config = resolveHarnessConfig(options);
  const credentialStatus = await new CliCredentials().inspect(config.provider);
  const report = await createDoctorReport(options, { credentialStatus });
  if (!options.json) process.stdout.write(`Profile: ${sanitizeTerminalText(options.profile ?? "explicit or environment defaults")}\n`);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) {
    process.exitCode = CLI_EXIT_CODES.doctorFailed;
  }
};
