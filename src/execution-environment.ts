import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  type AgentExecutionAuthorizationRequest,
  type AgentExecutionEnvironment,
  type AgentExecutionEnvironmentAcquireRequest,
  type AgentExecutionEnvironmentBinding,
  type AgentExecutionEnvironmentManifest,
  type AgentExecutionEnvironmentSession,
  type AgentStatus,
  type ToolExecutionContext
} from "@zhivex-ai/agents";
import { createAgentExecutionEnvironmentBinding } from "@zhivex-ai/agents/beta";

import {
  HARNESS_EXECUTION_POLICY_VERSION,
  type HarnessConfig,
  type HarnessExecutionConfig
} from "./config.js";
import {
  MAX_EDIT_CHANGES,
  MAX_EDIT_PROPOSAL_BYTES,
  createEditProposal,
  type FileDigest,
  type MutationAuditEntry
} from "./edit-contracts.js";
import { Workspace, type CommandResult } from "./workspace.js";

export const HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const HARNESS_OCI_LABEL = "com.zhivex.harness.execution";
export const HARNESS_OCI_LABEL_VALUE = "v1";

const TERMINAL_STATUSES = new Set<AgentStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);
const BUILT_IN_TOOL_NAMES = new Set([
  "list_files",
  "read_file",
  "search_files",
  "propose_edits",
  "apply_patch",
  "move_file",
  "quarantine_file",
  "restore_file",
  "run_check",
  "mutation_audit",
  "git_diff",
  "run_environment_command",
  "inspect_environment_patch",
  "apply_environment_patch",
  "environment_status"
]);

const digest = (value: string | Uint8Array): FileDigest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const runHash = (runId: string) => createHash("sha256").update(runId).digest("hex").slice(0, 24);

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const privateDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Execution artifact directory must be a real directory: ${directory}.`);
  }
  await chmod(directory, 0o700);
};

const atomicJson = async (target: string, value: unknown) => {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
};

const commandDisplay = (command: readonly string[]) => command.map((value) =>
  /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value)
).join(" ");

export interface OciCommandResult extends CommandResult {
  cancelled: boolean;
  outputLimitExceeded: boolean;
}

const spawnBounded = async (
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
    abortSignal?: AbortSignal;
    onStop?: (reason: "timeout" | "cancelled" | "output-limit") => void;
  }
): Promise<OciCommandResult> => {
  const child = Bun.spawn(command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let stopped = false;
  let retainedOutputBytes = 0;
  let totalOutputBytes = 0;
  const stop = (reason: "timeout" | "cancelled" | "output-limit") => {
    if (!stopped) {
      stopped = true;
      options.onStop?.(reason);
      child.kill("SIGKILL");
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop("timeout");
  }, options.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop("cancelled");
  };
  if (options.abortSignal?.aborted) {
    onAbort();
  } else {
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let omittedBytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalOutputBytes += next.value.byteLength;
      if (retainedOutputBytes < options.maxOutputBytes) {
        const remaining = options.maxOutputBytes - retainedOutputBytes;
        const kept = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining);
        chunks.push(kept);
        retainedOutputBytes += kept.byteLength;
        omittedBytes += next.value.byteLength - kept.byteLength;
      } else {
        omittedBytes += next.value.byteLength;
      }
      if (totalOutputBytes > options.maxOutputBytes) {
        outputLimitExceeded = true;
        stop("output-limit");
      }
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return omittedBytes > 0
      ? `${text}\n… output limit exceeded (${omittedBytes} bytes omitted)`
      : text;
  };

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      consume(child.stdout),
      consume(child.stderr),
      child.exited
    ]);
    return {
      command,
      exitCode,
      stdout,
      stderr,
      timedOut,
      cancelled,
      outputLimitExceeded
    };
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", onAbort);
  }
};

export interface OciImageInspection {
  runtime: "docker" | "podman";
  runtimeVersion: string;
  imageReference: string;
  imageId: string;
  imageDigest: string;
}

export interface OciRunRequest {
  runId: string;
  snapshotRoot: string;
  dependencyRoot?: string;
  command: string[];
  imageId: string;
  limits: {
    maxProcessRuntimeMs: number;
    maxProcessOutputBytes: number;
    maxMemoryMb: number;
    maxPids: number;
    maxCpus: number;
    maxWorkspaceBytes: number;
    maxFileWriteBytes: number;
    tmpfsMb: number;
  };
  abortSignal?: AbortSignal;
}

export interface HarnessOciRuntimeAdapter {
  inspectImage(image: string): Promise<OciImageInspection>;
  run(request: OciRunRequest): Promise<OciCommandResult>;
  removeRunContainers(runId: string): Promise<number>;
  cleanupOrphans(): Promise<number>;
}

const parseRuntimeVersion = (stdout: string, runtime: string) => {
  const version = stdout.trim();
  if (!version) throw new Error(`${runtime} did not report a server version.`);
  return version;
};

const validContainerIds = (stdout: string) => stdout
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter((value) => /^[a-f0-9]{12,64}$/.test(value));

const validVolumeNames = (stdout: string) => stdout
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter((value) => /^zhivex-harness-[A-Za-z0-9_.-]+$/.test(value));

const MAX_SYNC_ENTRIES = 10_000;

const validateSynchronizedSnapshot = async (
  stagedRoot: string,
  previousRoot: string,
  maxWorkspaceBytes: number,
  maxFileWriteBytes: number
) => {
  let entries = 0;
  let totalBytes = 0;
  const visit = async (directory: string, relativeDirectory = "") => {
    for (const name of await readdir(directory)) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(directory, name);
      if (!isInside(stagedRoot, absolute) || relative.length > 1_024) {
        throw new Error(`OCI workspace export contains an invalid path: ${relative}.`);
      }
      entries += 1;
      if (entries > MAX_SYNC_ENTRIES) {
        throw new Error(`OCI workspace export exceeds the ${MAX_SYNC_ENTRIES}-entry limit.`);
      }
      if (relative === "node_modules") {
        await rm(absolute, { recursive: true, force: true });
        continue;
      }
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new Error(`OCI workspace export contains a symbolic link: ${relative}.`);
      }
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || entry.nlink !== 1) {
        throw new Error(`OCI workspace export contains a special or linked file: ${relative}.`);
      }
      totalBytes += entry.size;
      if (totalBytes > maxWorkspaceBytes) {
        throw new Error(`OCI workspace export exceeds the ${maxWorkspaceBytes}-byte workspace limit.`);
      }
      if (entry.size > maxFileWriteBytes) {
        const previous = path.join(previousRoot, ...relative.split("/"));
        let unchanged = false;
        try {
          const previousEntry = await lstat(previous);
          unchanged = previousEntry.isFile() &&
            !previousEntry.isSymbolicLink() &&
            previousEntry.size === entry.size &&
            digest(await readFile(previous)) === digest(await readFile(absolute));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!unchanged) {
          throw new Error(`OCI command wrote a file above the ${maxFileWriteBytes}-byte limit: ${relative}.`);
        }
      }
    }
  };
  await visit(stagedRoot);
};

const replaceSnapshot = async (snapshotRoot: string, stagedRoot: string) => {
  const backupRoot = `${snapshotRoot}.${randomUUID()}.previous`;
  await rename(snapshotRoot, backupRoot);
  try {
    await rename(stagedRoot, snapshotRoot);
  } catch (error) {
    await rename(backupRoot, snapshotRoot).catch(() => undefined);
    throw error;
  }
  await rm(backupRoot, { recursive: true, force: true });
};

export class CliOciRuntimeAdapter implements HarnessOciRuntimeAdapter {
  readonly runtime: "docker" | "podman";
  private readonly hostEnvironment: Record<string, string>;

  constructor(runtime: "docker" | "podman") {
    this.runtime = runtime;
    this.hostEnvironment = Object.fromEntries(
      ["DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "HOME", "PATH", "XDG_RUNTIME_DIR"]
        .flatMap((name) => process.env[name] ? [[name, process.env[name] as string]] : [])
    );
  }

  private async cli(args: string[], timeoutMs = 30_000, maxOutputBytes = 1024 * 1024) {
    const result = await spawnBounded([this.runtime, ...args], {
      env: this.hostEnvironment,
      timeoutMs,
      maxOutputBytes
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`${this.runtime} ${args[0] ?? "command"} failed${detail ? `: ${detail}` : "."}`);
    }
    return result;
  }

  async inspectImage(image: string): Promise<OciImageInspection> {
    const version = await this.cli(["version", "--format", "{{.Server.Version}}"]);
    const inspected = await this.cli(["image", "inspect", image, "--format", "{{json .}}"]);
    const document = JSON.parse(inspected.stdout) as { Id?: unknown; RepoDigests?: unknown };
    if (typeof document.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(document.Id)) {
      throw new Error(`${this.runtime} returned an invalid immutable image id for ${image}.`);
    }
    const repoDigest = Array.isArray(document.RepoDigests)
      ? document.RepoDigests.find((value): value is string => typeof value === "string" && /@sha256:[a-f0-9]{64}$/.test(value))
      : undefined;
    return {
      runtime: this.runtime,
      runtimeVersion: parseRuntimeVersion(version.stdout, this.runtime),
      imageReference: image,
      imageId: document.Id,
      imageDigest: repoDigest?.slice(repoDigest.indexOf("@") + 1) ?? document.Id
    };
  }

  private async forceRemove(name: string) {
    await spawnBounded([this.runtime, "rm", "-f", name], {
      env: this.hostEnvironment,
      timeoutMs: 30_000,
      maxOutputBytes: 20_000
    }).catch(() => undefined);
  }

  private async removeVolume(name: string) {
    const result = await spawnBounded([this.runtime, "volume", "rm", name], {
      env: this.hostEnvironment,
      timeoutMs: 30_000,
      maxOutputBytes: 20_000
    });
    if (result.exitCode !== 0 && !/no such volume|not found/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(`${this.runtime} could not remove OCI workspace volume ${name}: ${result.stderr.trim()}`);
    }
  }

  async run(request: OciRunRequest): Promise<OciCommandResult> {
    const resourceName = `zhivex-harness-${runHash(request.runId)}-${randomUUID().slice(0, 8)}`;
    const name = `${resourceName}-job`;
    const exportName = `${resourceName}-export`;
    const volumeName = `${resourceName}-workspace`;
    const uid = process.getuid?.() ?? 65532;
    const gid = process.getgid?.() ?? 65532;
    const volumeArgs = [
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=tmpfs",
      "--opt",
      "device=tmpfs",
      "--opt",
      `o=size=${request.limits.maxWorkspaceBytes},uid=${uid},gid=${gid},mode=0700,noexec,nosuid,nodev`,
      "--label",
      `${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
      "--label",
      `com.zhivex.harness.run=${runHash(request.runId)}`,
      volumeName
    ];
    const args = [
      "create",
      "--name",
      name,
      "--label",
      `${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
      "--label",
      `com.zhivex.harness.run=${runHash(request.runId)}`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(request.limits.maxPids),
      "--memory",
      `${request.limits.maxMemoryMb}m`,
      "--cpus",
      String(request.limits.maxCpus),
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,nodev,size=${request.limits.tmpfsMb}m`,
      "--volume",
      `${volumeName}:/workspace`,
      "--user",
      `${uid}:${gid}`,
      "--env",
      "HOME=/tmp",
      "--env",
      "TMPDIR=/tmp",
      "--env",
      "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
      "--env",
      "CI=1",
      "--volume",
      `${request.snapshotRoot}:/seed:ro`,
      ...(request.dependencyRoot
        ? ["--volume", `${request.dependencyRoot}:/dependencies:ro`]
        : []),
      "--workdir",
      "/workspace",
      "--entrypoint",
      "bun",
      request.imageId,
      "-e",
      `await Bun.sleep(${request.limits.maxProcessRuntimeMs + 60_000})`
    ];
    let forcedRemoval: Promise<void> | undefined;
    const forceRemove = () => {
      forcedRemoval ??= this.forceRemove(name);
    };
    try {
      await this.cli(volumeArgs);
      await this.cli(args);
      await this.cli(["start", name]);
      await this.cli([
        "exec",
        "--workdir",
        "/workspace",
        "--user",
        `${uid}:${gid}`,
        name,
        "bun",
        "-e",
        "import { cp } from 'node:fs/promises'; await cp('/seed', '/workspace', { recursive: true, force: false, errorOnExist: true })"
      ], 60_000);
      if (request.dependencyRoot) {
        await this.cli([
          "exec",
          "--workdir",
          "/workspace",
          "--user",
          `${uid}:${gid}`,
          name,
          "bun",
          "-e",
          "import { symlink } from 'node:fs/promises'; await symlink('/dependencies', '/workspace/node_modules', 'dir')"
        ]);
      }
      const result = await spawnBounded([
        this.runtime,
        "exec",
        "--workdir",
        "/workspace",
        "--user",
        `${uid}:${gid}`,
        name,
        ...request.command
      ], {
        env: this.hostEnvironment,
        timeoutMs: request.limits.maxProcessRuntimeMs,
        maxOutputBytes: request.limits.maxProcessOutputBytes,
        ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
        onStop: forceRemove
      });
      if (result.timedOut || result.cancelled || result.outputLimitExceeded) {
        forceRemove();
        await forcedRemoval;
      } else if (result.exitCode === 0) {
        await this.cli(["pause", name]);
        const stagedRoot = path.join(path.dirname(request.snapshotRoot), `.workspace-sync-${randomUUID()}`);
        try {
          await privateDirectory(stagedRoot);
          try {
            await this.cli([
              "run",
              "--rm",
              "--name",
              exportName,
              "--label",
              `${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
              "--label",
              `com.zhivex.harness.run=${runHash(request.runId)}`,
              "--network",
              "none",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--pids-limit",
              "32",
              "--memory",
              "256m",
              "--cpus",
              "1",
              "--tmpfs",
              "/tmp:rw,noexec,nosuid,nodev,size=16m",
              "--user",
              `${uid}:${gid}`,
              "--volume",
              `${volumeName}:/workspace:ro`,
              "--volume",
              `${stagedRoot}:/export:rw`,
              "--workdir",
              "/workspace",
              "--entrypoint",
              "bun",
              request.imageId,
              "-e",
              "import { cp } from 'node:fs/promises'; await cp('/workspace', '/export', { recursive: true, force: false, errorOnExist: true })"
            ], 60_000);
          } finally {
            await this.forceRemove(exportName);
          }
          await validateSynchronizedSnapshot(
            stagedRoot,
            request.snapshotRoot,
            request.limits.maxWorkspaceBytes,
            request.limits.maxFileWriteBytes
          );
          await replaceSnapshot(request.snapshotRoot, stagedRoot);
        } finally {
          await rm(stagedRoot, { recursive: true, force: true });
        }
      }
      return {
        ...result,
        command: request.command
      };
    } finally {
      forceRemove();
      await forcedRemoval;
      await this.removeVolume(volumeName);
    }
  }

  private async removeByFilters(filters: string[]) {
    const listed = await spawnBounded([this.runtime, "ps", "-aq", ...filters.flatMap((filter) => ["--filter", filter])], {
      env: this.hostEnvironment,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    });
    if (listed.exitCode !== 0) return 0;
    const ids = validContainerIds(listed.stdout);
    if (ids.length === 0) return 0;
    const removed = await spawnBounded([this.runtime, "rm", "-f", ...ids], {
      env: this.hostEnvironment,
      timeoutMs: 60_000,
      maxOutputBytes: 1024 * 1024
    });
    if (removed.exitCode !== 0) {
      throw new Error(`${this.runtime} could not remove harness containers: ${removed.stderr.trim()}`);
    }
    return ids.length;
  }

  private async removeVolumesByFilters(filters: string[]) {
    const listed = await spawnBounded([
      this.runtime,
      "volume",
      "ls",
      "-q",
      ...filters.flatMap((filter) => ["--filter", filter])
    ], {
      env: this.hostEnvironment,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    });
    if (listed.exitCode !== 0) return 0;
    let removed = 0;
    for (const name of validVolumeNames(listed.stdout)) {
      try {
        await this.removeVolume(name);
        removed += 1;
      } catch {
        // An in-use labeled volume belongs to a still-active command and is not an orphan.
      }
    }
    return removed;
  }

  async removeRunContainers(runId: string) {
    const filters = [
      `label=${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
      `label=com.zhivex.harness.run=${runHash(runId)}`
    ];
    const containers = await this.removeByFilters(filters);
    const volumes = await this.removeVolumesByFilters(filters);
    return containers + volumes;
  }

  async cleanupOrphans() {
    let removed = 0;
    for (const status of ["created", "exited", "dead", "paused"]) {
      removed += await this.removeByFilters([
        `label=${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
        `status=${status}`
      ]);
    }
    removed += await this.removeVolumesByFilters([
      `label=${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`
    ]);
    return removed;
  }
}

interface SnapshotFile {
  path: string;
  digest: FileDigest;
  contents: Buffer;
  mode: number;
}

const collectSnapshotFiles = async (workspace: Workspace): Promise<Map<string, SnapshotFile>> => {
  const files = new Map<string, SnapshotFile>();
  let cursor: string | undefined;
  do {
    const page = await workspace.listFiles(".", { limit: 500, ...(cursor ? { cursor } : {}) });
    for (const file of page.files) {
      const absolute = path.join(workspace.root, ...file.path.split("/"));
      if (!isInside(workspace.root, absolute)) throw new Error(`Snapshot file escaped its workspace: ${file.path}.`);
      const before = await lstat(absolute);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Snapshot source is not a regular file: ${file.path}.`);
      const contents = await readFile(absolute);
      const after = await lstat(absolute);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`Snapshot source changed while reading: ${file.path}.`);
      }
      if (digest(contents) !== file.digest) throw new Error(`Snapshot digest changed while reading: ${file.path}.`);
      files.set(file.path, { path: file.path, digest: file.digest, contents, mode: before.mode & 0o777 });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return files;
};

const copyWorkspaceSnapshot = async (
  source: Workspace,
  baseRoot: string,
  snapshotRoot: string,
  maxWorkspaceBytes: number
) => {
  const files = await collectSnapshotFiles(source);
  const totalBytes = [...files.values()].reduce((total, file) => total + file.contents.byteLength, 0);
  if (totalBytes > maxWorkspaceBytes) {
    throw new Error(`Workspace snapshot exceeds the ${maxWorkspaceBytes}-byte OCI limit.`);
  }
  for (const root of [baseRoot, snapshotRoot]) {
    await rm(root, { recursive: true, force: true });
    await privateDirectory(root);
  }
  for (const file of files.values()) {
    for (const root of [baseRoot, snapshotRoot]) {
      const target = path.join(root, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.contents, { mode: file.mode });
      await chmod(target, file.mode);
    }
  }
  return { files: files.size, bytes: totalBytes };
};

interface EnvironmentMetadata {
  schemaVersion: typeof HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  hostWorkspace: string;
  binding: AgentExecutionEnvironmentBinding;
  image: OciImageInspection;
  createdAt: string;
  acquiredAt: string;
  releasedAt?: string;
  status?: AgentStatus;
  snapshot: { files: number; bytes: number };
}

interface EnvironmentPatchEntry {
  path: string;
  operation: "create" | "update" | "delete";
  beforeDigest?: FileDigest;
  afterDigest?: FileDigest;
  beforeContent?: string;
  afterContent?: string;
  bytes: number;
}

export interface EnvironmentPatchInspection {
  schemaVersion: typeof HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION;
  kind: "environment-patch";
  patchId: FileDigest;
  runId: string;
  entries: Array<Omit<EnvironmentPatchEntry, "beforeContent" | "afterContent">>;
  totalBytes: number;
}

export interface EnvironmentPatchImportResult {
  schemaVersion: typeof HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION;
  kind: "environment-patch-import";
  patchId: FileDigest;
  runId: string;
  changes: MutationAuditEntry[];
}

const patchPayload = (runId: string, entries: EnvironmentPatchEntry[]) => ({
  schemaVersion: HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
  kind: "environment-patch" as const,
  runId,
  entries: entries.map(({ beforeContent: _before, afterContent: _after, ...entry }) => entry)
});

const textContent = (file: SnapshotFile, maxFileWriteBytes: number) => {
  if (file.contents.byteLength > maxFileWriteBytes) {
    throw new Error(`Environment patch file exceeds the ${maxFileWriteBytes}-byte import limit: ${file.path}.`);
  }
  if (file.contents.includes(0)) {
    throw new Error(`Environment patch contains a binary file that cannot be imported: ${file.path}.`);
  }
  return file.contents.toString("utf8");
};

const createEnvironmentPatch = async (
  runId: string,
  base: Workspace,
  current: Workspace,
  maxFileWriteBytes: number
) => {
  const before = await collectSnapshotFiles(base);
  const after = await collectSnapshotFiles(current);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: EnvironmentPatchEntry[] = [];
  let totalBytes = 0;
  for (const filePath of paths) {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    if (oldFile?.digest === newFile?.digest) continue;
    const operation = !oldFile ? "create" : !newFile ? "delete" : "update";
    const beforeContent = oldFile ? textContent(oldFile, maxFileWriteBytes) : undefined;
    const afterContent = newFile ? textContent(newFile, maxFileWriteBytes) : undefined;
    const bytes = newFile?.contents.byteLength ?? 0;
    totalBytes += bytes;
    entries.push({
      path: filePath,
      operation,
      ...(oldFile ? { beforeDigest: oldFile.digest } : {}),
      ...(beforeContent !== undefined ? { beforeContent } : {}),
      ...(newFile ? { afterDigest: newFile.digest } : {}),
      ...(afterContent !== undefined ? { afterContent } : {}),
      bytes
    });
  }
  if (entries.length > MAX_EDIT_CHANGES) {
    throw new Error(`Environment patch exceeds the ${MAX_EDIT_CHANGES}-file import limit.`);
  }
  if (totalBytes > MAX_EDIT_PROPOSAL_BYTES) {
    throw new Error(`Environment patch exceeds the ${MAX_EDIT_PROPOSAL_BYTES}-byte import limit.`);
  }
  const payload = patchPayload(runId, entries);
  return { entries, totalBytes, patchId: digest(JSON.stringify(payload)) };
};

const inspectHostPrecondition = async (
  workspace: Workspace,
  filePath: string,
  expectedDigest: FileDigest | undefined
) => {
  try {
    const current = await workspace.readFile(filePath, 1, 1);
    if (!expectedDigest) throw new Error(`Host patch target already exists: ${filePath}.`);
    if (current.digest !== expectedDigest) {
      throw new Error(`Host patch target changed after the environment snapshot: ${filePath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expectedDigest) return;
    throw error;
  }
};

const importPatch = async (
  runId: string,
  expectedPatchId: FileDigest,
  host: Workspace,
  base: Workspace,
  current: Workspace,
  maxFileWriteBytes: number
): Promise<EnvironmentPatchImportResult> => {
  const patch = await createEnvironmentPatch(runId, base, current, maxFileWriteBytes);
  if (patch.patchId !== expectedPatchId) {
    throw new Error("Environment patch changed after review; inspect it again before import.");
  }
  if (patch.entries.length === 0) throw new Error("Environment patch contains no changes.");
  for (const entry of patch.entries) {
    await inspectHostPrecondition(host, entry.path, entry.beforeDigest);
  }
  const writes = patch.entries.filter((entry) => entry.operation !== "delete");
  const deletes = patch.entries.filter((entry) => entry.operation === "delete");
  const audits: MutationAuditEntry[] = [];
  if (writes.length) {
    const changes = writes.map((entry) => ({
      path: entry.path,
      expectedDigest: entry.beforeDigest ?? null,
      content: entry.afterContent!
    }));
    const proposal = createEditProposal({ changes });
    const result = await host.applyPatch({ proposalId: proposal.proposalId, changes });
    audits.push(...result.changes);
  }
  const quarantined: Array<{ quarantineId: string; path: string; digest: FileDigest }> = [];
  try {
    for (const entry of deletes) {
      const result = await host.quarantineFile({ path: entry.path, expectedDigest: entry.beforeDigest! });
      quarantined.push(result);
      audits.push(result.audit);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const item of [...quarantined].reverse()) {
      try {
        await host.restoreQuarantined({ quarantineId: item.quarantineId, expectedDigest: item.digest });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    const updatedWrites = writes.filter((entry) => entry.operation === "update");
    if (updatedWrites.length) {
      try {
        const changes = updatedWrites.map((entry) => ({
          path: entry.path,
          expectedDigest: entry.afterDigest!,
          content: entry.beforeContent!
        }));
        const proposal = createEditProposal({ changes });
        await host.applyPatch({ proposalId: proposal.proposalId, changes });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const entry of writes.filter((candidate) => candidate.operation === "create").reverse()) {
      try {
        await host.quarantineFile({ path: entry.path, expectedDigest: entry.afterDigest! });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "Environment patch deletion failed and rollback was incomplete.");
    }
    throw error;
  }
  return {
    schemaVersion: HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
    kind: "environment-patch-import",
    patchId: patch.patchId,
    runId,
    changes: audits
  };
};

export interface HarnessExecutionSession extends AgentExecutionEnvironmentSession {
  readonly kind: "zhivex-oci";
  readonly runId: string;
  readonly workspace: Workspace;
  status(): Promise<Record<string, unknown>>;
  runCommand(command: string, args: readonly string[], context?: ToolExecutionContext): Promise<CommandResult>;
  runCheck(check: string, expectedScript: string, allowedChecks: readonly string[], context?: ToolExecutionContext): Promise<CommandResult>;
  inspectPatch(): Promise<EnvironmentPatchInspection>;
  importPatch(host: Workspace, patchId: FileDigest): Promise<EnvironmentPatchImportResult>;
}

export const harnessExecutionSession = (
  context: ToolExecutionContext | undefined
): HarnessExecutionSession | undefined => {
  const candidate = context?.executionEnvironment as Partial<HarnessExecutionSession> | undefined;
  return candidate?.kind === "zhivex-oci" ? candidate as HarnessExecutionSession : undefined;
};

export interface HarnessOciExecutionEnvironment extends AgentExecutionEnvironment {
  readonly image: OciImageInspection;
  readonly runtime: HarnessOciRuntimeAdapter;
}

export interface CreateHarnessOciEnvironmentOptions {
  config: Extract<HarnessExecutionConfig, { backend: "oci" }>;
  workspace: Workspace;
  stateDirectory: string;
  runtime?: HarnessOciRuntimeAdapter;
}

export const createHarnessOciExecutionEnvironment = async (
  options: CreateHarnessOciEnvironmentOptions
): Promise<HarnessOciExecutionEnvironment> => {
  const runtime = options.runtime ?? new CliOciRuntimeAdapter(options.config.runtime);
  const image = await runtime.inspectImage(options.config.image);
  const workspaceIdentity = digest(options.workspace.root);
  const manifest: AgentExecutionEnvironmentManifest = {
    schemaVersion: 1,
    id: `zhivex-harness-${options.config.runtime}-oci`,
    version: `${HARNESS_EXECUTION_POLICY_VERSION}:${image.imageDigest}`,
    backend: "container",
    assurance: "enforced",
    isolation: "per-tool-call",
    workspace: {
      id: workspaceIdentity,
      root: "/workspace",
      cwd: "/workspace",
      access: "read-write",
      followSymlinks: false,
      readablePaths: ["/workspace"],
      writablePaths: ["/workspace", "/tmp"]
    },
    permissions: {
      undeclaredTools: "deny",
      filesystem: "read-write",
      network: { mode: "deny", allowedDomains: [], allowedPorts: [], allowPrivateNetworks: false },
      process: { shell: "allowlist", allowedCommands: [...options.config.allowedCommands] },
      environment: { inheritedVariables: [] }
    },
    limits: {
      maxProcessRuntimeMs: options.config.maxProcessRuntimeMs,
      maxProcessOutputBytes: options.config.maxProcessOutputBytes,
      maxConcurrentProcesses: 1,
      maxMemoryMb: options.config.maxMemoryMb,
      maxWorkspaceBytes: options.config.maxWorkspaceBytes,
      maxFileWriteBytes: options.config.maxFileWriteBytes,
      maxNetworkRequests: 0,
      maxNetworkBytes: 0
    },
    metadata: {
      policyVersion: options.config.policyVersion,
      runtime: image.runtime,
      runtimeVersion: image.runtimeVersion,
      imageReference: image.imageReference,
      imageId: image.imageId,
      imageDigest: image.imageDigest,
      maxPids: options.config.maxPids,
      maxCpus: options.config.maxCpus,
      tmpfsMb: options.config.tmpfsMb,
      patchImportApproval: true,
      hostMutationMode: "reviewed-environment-patch"
    }
  };
  const binding = createAgentExecutionEnvironmentBinding(manifest);
  const environmentRoot = path.join(options.stateDirectory, "environments");

  return {
    manifest,
    image,
    runtime,
    async acquire(request: AgentExecutionEnvironmentAcquireRequest) {
      await privateDirectory(environmentRoot);
      const directory = path.join(environmentRoot, runHash(request.runId));
      await privateDirectory(directory);
      const metadataPath = path.join(directory, "environment.json");
      const baseRoot = path.join(directory, "base");
      const snapshotRoot = path.join(directory, "workspace");
      let metadata: EnvironmentMetadata;
      try {
        const entry = await lstat(metadataPath);
        if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Execution metadata must be a regular file.");
        metadata = JSON.parse(await readFile(metadataPath, "utf8")) as EnvironmentMetadata;
        if (
          metadata.schemaVersion !== HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION ||
          metadata.runId !== request.runId ||
          metadata.hostWorkspace !== options.workspace.root ||
          metadata.binding.fingerprint !== binding.fingerprint ||
          metadata.binding.workspaceId !== binding.workspaceId
        ) {
          throw new Error(`Execution artifact binding changed for run ${request.runId}.`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const snapshot = await copyWorkspaceSnapshot(
          options.workspace,
          baseRoot,
          snapshotRoot,
          options.config.maxWorkspaceBytes
        );
        const now = new Date().toISOString();
        metadata = {
          schemaVersion: HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
          runId: request.runId,
          hostWorkspace: options.workspace.root,
          binding,
          image,
          createdAt: now,
          acquiredAt: now,
          snapshot
        };
      }
      metadata.acquiredAt = new Date().toISOString();
      delete metadata.releasedAt;
      delete metadata.status;
      await atomicJson(metadataPath, metadata);
      const workspace = await Workspace.open(snapshotRoot);
      const base = await Workspace.open(baseRoot);
      const dependencyPath = path.join(options.workspace.root, "node_modules");
      let dependencyRoot: string | undefined;
      try {
        const entry = await lstat(dependencyPath);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error("node_modules must be a real directory before it can be mounted read-only.");
        }
        dependencyRoot = await realpath(dependencyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const runCommand = async (
        command: string,
        args: readonly string[],
        context?: ToolExecutionContext
      ) => {
        if (!options.config.allowedCommands.includes(command)) {
          throw new Error(`The OCI command "${command}" is not in the explicit allowlist.`);
        }
        if (args.length > 256 || args.some((value) => value.length > 8_192 || value.includes("\0"))) {
          throw new Error("OCI command arguments exceed the bounded argument contract.");
        }
        const result = await runtime.run({
          runId: request.runId,
          snapshotRoot,
          ...(dependencyRoot ? { dependencyRoot } : {}),
          command: [command, ...args],
          imageId: image.imageId,
          limits: {
            maxProcessRuntimeMs: options.config.maxProcessRuntimeMs,
            maxProcessOutputBytes: options.config.maxProcessOutputBytes,
            maxMemoryMb: options.config.maxMemoryMb,
            maxPids: options.config.maxPids,
            maxCpus: options.config.maxCpus,
            maxWorkspaceBytes: options.config.maxWorkspaceBytes,
            maxFileWriteBytes: options.config.maxFileWriteBytes,
            tmpfsMb: options.config.tmpfsMb
          },
          ...(context?.abortSignal ?? request.abortSignal
            ? { abortSignal: context?.abortSignal ?? request.abortSignal }
            : {})
        });
        const forcedExitCode = result.cancelled
          ? 130
          : result.timedOut
            ? 124
            : result.outputLimitExceeded
              ? 125
              : result.exitCode;
        return {
          command: result.command,
          exitCode: forcedExitCode,
          stdout: result.stdout,
          stderr: [
            result.stderr,
            ...(result.cancelled ? ["OCI command cancelled."] : []),
            ...(result.timedOut ? ["OCI command timed out."] : []),
            ...(result.outputLimitExceeded ? ["OCI command exceeded the output limit."] : [])
          ].filter(Boolean).join("\n"),
          timedOut: result.timedOut
        };
      };
      const session: HarnessExecutionSession = {
        kind: "zhivex-oci",
        runId: request.runId,
        manifest,
        binding,
        workspace,
        async authorize(authorization: AgentExecutionAuthorizationRequest) {
          const name = authorization.tool.name;
          if (!BUILT_IN_TOOL_NAMES.has(name) && !name.startsWith("delegate_")) {
            return { decision: "deny", reason: `Tool "${name}" is undeclared by the enforced OCI policy.` };
          }
          if (name === "run_environment_command") {
            const input = authorization.input as { command?: unknown; args?: unknown };
            if (typeof input.command !== "string" || !options.config.allowedCommands.includes(input.command)) {
              return { decision: "deny", reason: "The requested OCI executable is not allowlisted." };
            }
          }
          return {
            decision: "allow",
            metadata: {
              environmentId: binding.environmentId,
              imageDigest: image.imageDigest,
              network: "deny",
              phase: authorization.phase
            }
          };
        },
        async execute(_authorization, operation) {
          return await operation();
        },
        async status() {
          const patch = await createEnvironmentPatch(request.runId, base, workspace, options.config.maxFileWriteBytes);
          return {
            schemaVersion: HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
            kind: "environment-status",
            runId: request.runId,
            binding,
            runtime: image.runtime,
            runtimeVersion: image.runtimeVersion,
            imageReference: image.imageReference,
            imageDigest: image.imageDigest,
            network: "deny",
            rootFilesystem: "read-only",
            workspace: "ephemeral-snapshot",
            patchId: patch.patchId,
            changedFiles: patch.entries.length
          };
        },
        runCommand,
        async runCheck(check, expectedScript, allowedChecks, context) {
          if (!/^[A-Za-z0-9:_-]+$/.test(check) || !allowedChecks.includes(check)) {
            throw new Error(`The check "${check}" is not in the explicit allowlist.`);
          }
          let manifestDocument: { scripts?: Record<string, string> };
          try {
            manifestDocument = JSON.parse(await readFile(path.join(snapshotRoot, "package.json"), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error("The environment snapshot does not contain package.json.");
            }
            throw error;
          }
          const actual = manifestDocument.scripts?.[check];
          if (!actual) throw new Error(`package.json does not define the "${check}" script.`);
          if (actual !== expectedScript) throw new Error(`The "${check}" script changed or does not match expectedScript.`);
          return runCommand("bun", ["--no-env-file", "run", check], context);
        },
        async inspectPatch() {
          const patch = await createEnvironmentPatch(request.runId, base, workspace, options.config.maxFileWriteBytes);
          const payload = patchPayload(request.runId, patch.entries);
          return {
            ...payload,
            patchId: patch.patchId,
            totalBytes: patch.totalBytes
          };
        },
        importPatch(host, patchId) {
          return importPatch(request.runId, patchId, host, base, workspace, options.config.maxFileWriteBytes);
        },
        async release(result) {
          await runtime.removeRunContainers(request.runId);
          metadata.releasedAt = new Date().toISOString();
          metadata.status = result.status;
          await atomicJson(metadataPath, metadata);
        }
      };
      return session;
    }
  };
};

export interface ExecutionArtifactCleanupResult {
  scanned: number;
  deleted: number;
  skipped: number;
}

export const cleanupHarnessExecutionArtifacts = async (
  stateDirectory: string,
  before: number
): Promise<ExecutionArtifactCleanupResult> => {
  const root = path.join(stateDirectory, "environments");
  const result = { scanned: 0, deleted: 0, skipped: 0 };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{24}$/.test(entry.name)) {
      result.skipped += 1;
      continue;
    }
    result.scanned += 1;
    const directory = path.join(root, entry.name);
    const resolved = await realpath(directory);
    if (!isInside(root, resolved)) {
      result.skipped += 1;
      continue;
    }
    try {
      const metadataPath = path.join(directory, "environment.json");
      const metadataEntry = await lstat(metadataPath);
      if (metadataEntry.isSymbolicLink() || !metadataEntry.isFile()) throw new Error("unsafe metadata");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as EnvironmentMetadata;
      const releasedAt = metadata.releasedAt ? Date.parse(metadata.releasedAt) : Number.NaN;
      if (!metadata.status || !TERMINAL_STATUSES.has(metadata.status) || !Number.isFinite(releasedAt) || releasedAt >= before) {
        result.skipped += 1;
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      result.deleted += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
};

export const executionFingerprintInput = (
  execution: HarnessConfig["execution"],
  environment?: HarnessOciExecutionEnvironment
) => execution.backend === "none"
  ? { backend: "none" as const }
  : {
      ...execution,
      image: environment?.image,
      binding: environment ? createAgentExecutionEnvironmentBinding(environment.manifest) : undefined
    };

export const describeOciCommand = (command: string, args: readonly string[]) =>
  commandDisplay([command, ...args]);
