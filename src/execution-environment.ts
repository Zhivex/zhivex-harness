import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
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
  type HarnessExecutionConfig,
  type HarnessOciRuntime
} from "./config.js";
import {
  MAX_EDIT_CHANGES,
  MAX_EDIT_PROPOSAL_BYTES,
  createEditProposal,
  type FileDigest,
  type MutationAuditEntry
} from "./edit-contracts.js";
import { FileSizeLimitError, readRegularFileNoFollow } from "./file-security.js";
import { resolvePackageCheckCommand } from "./package-manager.js";
import { Workspace, type CommandResult } from "./workspace.js";

export const HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const HARNESS_OCI_LABEL = "com.zhivex.harness.execution";
export const HARNESS_OCI_LABEL_VALUE = "v1";
export const HARNESS_OCI_OWNER_PID_LABEL = "com.zhivex.harness.owner-pid";

const TERMINAL_STATUSES = new Set<AgentStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);
const EXECUTION_ARTIFACT_DIRECTORY_PATTERN = /^[a-f0-9]{24}$/;
const STAGED_EXECUTION_ARTIFACT_DIRECTORY_PATTERN =
  /^\.cleanup-([a-f0-9]{24})-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const BUILT_IN_TOOL_NAMES = new Set([
  "list_files",
  "read_file",
  "read_files",
  "search_files",
  "search_many",
  "load_skill",
  "propose_edits",
  "apply_patch",
  "apply_reviewed_edits",
  "move_file",
  "quarantine_file",
  "restore_file",
  "run_check",
  "mutation_audit",
  "git_diff",
  "run_environment_command",
  "run_environment_batch",
  "run_environment_shell",
  "inspect_environment_patch",
  "apply_environment_patch",
  "verify_and_apply_environment_patch",
  "verify_and_apply_reviewed_edits",
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

const elapsedMilliseconds = (startedAt: bigint) =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000;

export interface OciPhaseLatencies {
  hostSynchronizationMs?: number;
  sessionCreationMs?: number;
  commandAndAttestationMs: number;
  workspaceExportMs?: number;
  totalMs: number;
}

export interface OciCommandResult extends CommandResult {
  cancelled: boolean;
  outputLimitExceeded: boolean;
  /** True when the command reused an already-seeded run container. */
  sessionReused?: boolean;
  /** True only after the command workspace was validated and durably published. */
  workspacePublished?: boolean;
  /** True when publication required copying a changed workspace back to the host snapshot. */
  workspaceExported?: boolean;
  /** Lower-level OCI phase timings for diagnostics and benchmark attribution. */
  phaseLatencies?: OciPhaseLatencies;
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
    input?: string;
  }
): Promise<OciCommandResult> => {
  const child = spawn(command[0] as string, command.slice(1), {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? {},
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (options.input !== undefined) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  }
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

  const consume = async (stream: NodeJS.ReadableStream) => {
    const chunks: Uint8Array[] = [];
    let omittedBytes = 0;
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      totalOutputBytes += chunk.byteLength;
      if (retainedOutputBytes < options.maxOutputBytes) {
        const remaining = options.maxOutputBytes - retainedOutputBytes;
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(kept);
        retainedOutputBytes += kept.byteLength;
        omittedBytes += chunk.byteLength - kept.byteLength;
      } else {
        omittedBytes += chunk.byteLength;
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

  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 137));
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      consume(child.stdout as NodeJS.ReadableStream),
      consume(child.stderr as NodeJS.ReadableStream),
      exited
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

export interface OciRunBatchRequest extends Omit<OciRunRequest, "command"> {
  commands: string[][];
}

export interface OciCommandBatchResult extends OciCommandResult {
  commands: string[][];
}

export interface HarnessOciRuntimeAdapter {
  inspectImage(image: string): Promise<OciImageInspection>;
  run(request: OciRunRequest): Promise<OciCommandResult>;
  /** Optional optimized path that performs one process/seal/publication cycle for the batch. */
  runBatch?(request: OciRunBatchRequest): Promise<OciCommandBatchResult>;
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

const hostProcessIsAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const MAX_SYNC_ENTRIES = 10_000;

interface ValidatedSnapshot {
  entries: number;
  totalBytes: number;
  seal: FileDigest;
  metadataFingerprint: FileDigest;
}

const updateSnapshotMetadata = (
  target: ReturnType<typeof createHash>,
  kind: "directory" | "file",
  relative: string,
  entry: Stats
) => {
  target.update([
    kind,
    relative,
    entry.dev,
    entry.ino,
    entry.size,
    entry.mtimeMs,
    entry.ctimeMs,
    entry.mode & 0o777
  ].join("\0"));
  target.update("\0");
};

const validateSynchronizedSnapshot = async (
  stagedRoot: string,
  previousRoot: string,
  maxWorkspaceBytes: number,
  maxFileWriteBytes: number
): Promise<ValidatedSnapshot> => {
  let entries = 0;
  let totalBytes = 0;
  const seal = createHash("sha256");
  const metadata = createHash("sha256");
  const visit = async (directory: string, relativeDirectory = "") => {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const name = child.name;
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
      if (child.isSymbolicLink()) {
        throw new Error(`OCI workspace export contains a symbolic link: ${relative}.`);
      }
      if (child.isDirectory()) {
        const directoryEntry = await lstat(absolute);
        if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
          throw new Error(`OCI workspace export directory changed while it was being validated: ${relative}.`);
        }
        updateSnapshotMetadata(metadata, "directory", relative, directoryEntry);
        seal.update(`directory\0${relative}\0${directoryEntry.mode & 0o777}\0`);
        await visit(absolute, relative);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`OCI workspace export contains a special or linked file: ${relative}.`);
      }
      let file;
      try {
        file = await readRegularFileNoFollow(absolute, {
          label: `OCI workspace export file ${relative}`,
          maxBytes: maxWorkspaceBytes - totalBytes,
          requireSingleLink: true
        });
      } catch (error) {
        if (error instanceof FileSizeLimitError) {
          throw new Error(`OCI workspace export exceeds the ${maxWorkspaceBytes}-byte workspace limit.`);
        }
        throw error;
      }
      const contents = file.contents;
      const entry = file.stat;
      totalBytes += entry.size;
      if (totalBytes > maxWorkspaceBytes) {
        throw new Error(`OCI workspace export exceeds the ${maxWorkspaceBytes}-byte workspace limit.`);
      }
      const contentDigest = digest(contents);
      updateSnapshotMetadata(metadata, "file", relative, entry);
      seal.update(`file\0${relative}\0${entry.mode & 0o777}\0${entry.size}\0${contentDigest}\0`);
      if (entry.size > maxFileWriteBytes) {
        const previous = path.join(previousRoot, ...relative.split("/"));
        let unchanged = false;
        try {
          const previousFile = await readRegularFileNoFollow(previous, {
            label: `Previous OCI workspace file ${relative}`,
            maxBytes: entry.size
          });
          unchanged = previousFile.stat.size === entry.size && digest(previousFile.contents) === contentDigest;
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
  return {
    entries,
    totalBytes,
    seal: `sha256:${seal.digest("hex")}`,
    metadataFingerprint: `sha256:${metadata.digest("hex")}`
  };
};

const snapshotMetadataFingerprint = async (
  root: string,
  maxWorkspaceBytes: number
): Promise<FileDigest> => {
  let entries = 0;
  let totalBytes = 0;
  const metadata = createHash("sha256");
  const visit = async (directory: string, relativeDirectory = "") => {
    for (const name of (await readdir(directory)).sort()) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relative === "node_modules") continue;
      const absolute = path.join(directory, name);
      if (!isInside(root, absolute) || relative.length > 1_024) {
        throw new Error(`OCI workspace snapshot contains an invalid path: ${relative}.`);
      }
      entries += 1;
      if (entries > MAX_SYNC_ENTRIES) {
        throw new Error(`OCI workspace snapshot exceeds the ${MAX_SYNC_ENTRIES}-entry limit.`);
      }
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) {
        throw new Error(`OCI workspace snapshot contains a symbolic link: ${relative}.`);
      }
      if (entry.isDirectory()) {
        updateSnapshotMetadata(metadata, "directory", relative, entry);
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || entry.nlink !== 1) {
        throw new Error(`OCI workspace snapshot contains a special or linked file: ${relative}.`);
      }
      totalBytes += entry.size;
      if (totalBytes > maxWorkspaceBytes) {
        throw new Error(`OCI workspace snapshot exceeds the ${maxWorkspaceBytes}-byte workspace limit.`);
      }
      updateSnapshotMetadata(metadata, "file", relative, entry);
    }
  };
  await visit(root);
  return `sha256:${metadata.digest("hex")}`;
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

interface PersistentOciSession {
  key: string;
  requestFingerprint: FileDigest;
  name: string;
  volumeName: string;
  snapshotSeal: FileDigest;
  hostFingerprint: FileDigest;
}

const OCI_BACKGROUND_PROCESS_MARKER = "ZHIVEX_HARNESS_BACKGROUND_PROCESS";
const OCI_COMMAND_TIMEOUT_MARKER = "ZHIVEX_HARNESS_COMMAND_TIMEOUT";
const OCI_ATTESTATION_TIMEOUT_MS = 60_000;
const OCI_ATTESTATION_PROTOCOL_BYTES = 160;
const OCI_ATTESTATION_PATTERN = /\nZHIVEX_HARNESS_ATTESTATION:(sha256:[a-f0-9]{64})\n$/;

const OCI_COMMAND_RUNNER_SCRIPT = [
  "import { createHash } from 'node:crypto';",
  "import { spawn } from 'node:child_process';",
  "import { readFileSync } from 'node:fs';",
  "import { lstat, readFile, readdir, readlink, rm } from 'node:fs/promises';",
  "import path from 'node:path';",
  "const request=JSON.parse(readFileSync(0,'utf8'));",
  "if(!Array.isArray(request.commands)||request.commands.length===0||!request.commands.every((command)=>Array.isArray(command)&&command.length>0&&command.every((value)=>typeof value==='string')))throw new Error('invalid OCI command batch');",
  "if(!Number.isSafeInteger(request.maxProcessRuntimeMs)||request.maxProcessRuntimeMs<1)throw new Error('invalid OCI command timeout');",
  "const deadline=Date.now()+request.maxProcessRuntimeMs;",
  "const run=async(command,timeoutMs)=>await new Promise((resolve,reject)=>{",
  "const child=spawn(command[0],command.slice(1),{stdio:['ignore','inherit','inherit'],detached:true});",
  "let settled=false;let timedOut=false;",
  "const finish=(value,error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};",
  "const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},timeoutMs);",
  "child.once('error',(error)=>finish(undefined,error));",
  "child.once('exit',(code)=>finish({exitCode:timedOut?124:(code??137),timedOut}));",
  "});",
  "for(const command of request.commands){const remaining=deadline-Date.now();if(remaining<=0){console.error('ZHIVEX_HARNESS_COMMAND_TIMEOUT');process.exit(124);}const result=await run(command,remaining);if(result.timedOut){console.error('ZHIVEX_HARNESS_COMMAND_TIMEOUT');process.exit(124);}if(result.exitCode!==0)process.exit(result.exitCode);}",
  "const unexpectedProcesses=async()=>(await readdir('/proc')).filter((name)=>/^\\d+$/.test(name)).map(Number).filter((pid)=>pid!==1&&pid!==process.pid);",
  "if((await unexpectedProcesses()).length>0){console.error('ZHIVEX_HARNESS_BACKGROUND_PROCESS');process.exit(126);}",
  "const root='/workspace';",
  "const seal=createHash('sha256');",
  "const modules=path.join(root,'node_modules');",
  "try{",
  "if(request.hasDependencies===true){const entry=await lstat(modules);if(!entry.isSymbolicLink()||(await readlink(modules))!=='/dependencies')throw new Error('read-only dependency mount was replaced');}else{await rm(modules,{recursive:true,force:true});}",
  "const digest=(value)=>`sha256:${createHash('sha256').update(value).digest('hex')}`;",
  "const same=(before,after)=>before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&(before.mode&0o777)===(after.mode&0o777);",
  "const visit=async(directory,base='')=>{",
  "for(const name of (await readdir(directory)).sort()){",
  "const relative=base?`${base}/${name}`:name;",
  "if(relative==='node_modules')continue;",
  "const absolute=path.join(directory,name);",
  "const entry=await lstat(absolute);",
  "if(entry.isSymbolicLink())throw new Error(`symbolic link: ${relative}`);",
  "if(entry.isDirectory()){seal.update(`directory\\0${relative}\\0${entry.mode&0o777}\\0`);await visit(absolute,relative);continue;}",
  "if(!entry.isFile()||entry.nlink!==1)throw new Error(`special or linked file: ${relative}`);",
  "const contents=await readFile(absolute);",
  "const after=await lstat(absolute);",
  "if(!same(entry,after))throw new Error(`changed while sealing: ${relative}`);",
  "seal.update(`file\\0${relative}\\0${entry.mode&0o777}\\0${entry.size}\\0${digest(contents)}\\0`);",
  "}",
  "};",
  "await visit(root);",
  "if((await unexpectedProcesses()).length>0){console.error('ZHIVEX_HARNESS_BACKGROUND_PROCESS');process.exit(126);}",
  "for(const name of await readdir('/tmp'))await rm(path.join('/tmp',name),{recursive:true,force:true});",
  "process.stdout.write(`\\nZHIVEX_HARNESS_ATTESTATION:sha256:${seal.digest('hex')}\\n`);",
  "}catch(error){console.error(`ZHIVEX_HARNESS_ATTESTATION_FAILURE:${error instanceof Error?error.message:String(error)}`);process.exit(127);}"
].join("");

// The controller owns the container lifetime; only session release or a failure path
// may stop it. A finite sleep would eventually expire across cumulative unpaused time.
export const OCI_SESSION_CONTROLLER_SCRIPT = "setInterval(()=>{},2147483647);";

export class CliOciRuntimeAdapter implements HarnessOciRuntimeAdapter {
  readonly runtime: "docker" | "podman";
  private readonly hostEnvironment: Record<string, string>;
  private readonly sessions = new Map<string, PersistentOciSession>();
  private readonly runQueues = new Map<string, Promise<void>>();

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

  private requestFingerprint(request: OciRunRequest | OciRunBatchRequest) {
    return digest(JSON.stringify({
      runId: request.runId,
      snapshotRoot: request.snapshotRoot,
      dependencyRoot: request.dependencyRoot ?? null,
      imageId: request.imageId,
      limits: request.limits
    }));
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const key = runHash(runId);
    const previous = this.runQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.runQueues.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.runQueues.get(key) === tail) this.runQueues.delete(key);
    }
  }

  private async destroySession(session: PersistentOciSession) {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    await this.forceRemove(session.name);
    await this.removeVolume(session.volumeName);
  }

  private async createSession(
    request: OciRunRequest | OciRunBatchRequest,
    requestFingerprint: FileDigest,
    snapshotSeal: FileDigest,
    hostFingerprint: FileDigest
  ): Promise<PersistentOciSession> {
    const resourceName = `zhivex-harness-${runHash(request.runId)}-${randomUUID().slice(0, 8)}`;
    const name = `${resourceName}-job`;
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
      "--label",
      `${HARNESS_OCI_OWNER_PID_LABEL}=${process.pid}`,
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
      "NPM_CONFIG_CACHE=/tmp/npm-cache",
      "--env",
      "CI=1",
      ...(request.dependencyRoot
        ? ["--volume", `${request.dependencyRoot}:/dependencies:ro`]
        : []),
      "--workdir",
      "/workspace",
      "--entrypoint",
      "node",
      request.imageId,
      "--input-type=module",
      "-e",
      OCI_SESSION_CONTROLLER_SCRIPT
    ];
    let volumeCreated = false;
    try {
      await this.cli(volumeArgs);
      volumeCreated = true;
      await this.cli(args);
      await this.cli(["start", name]);
      await this.cli([
        "cp",
        "-a",
        `${request.snapshotRoot}${path.sep}.`,
        `${name}:/workspace`
      ], 60_000);
      if (request.dependencyRoot) {
        await this.cli([
          "exec",
          "--workdir",
          "/workspace",
          "--user",
          `${uid}:${gid}`,
          name,
          "node",
          "--input-type=module",
          "-e",
          "import { symlink } from 'node:fs/promises'; await symlink('/dependencies', '/workspace/node_modules', 'dir')"
        ]);
      }
      const session: PersistentOciSession = {
        key: runHash(request.runId),
        requestFingerprint,
        name,
        volumeName,
        snapshotSeal,
        hostFingerprint
      };
      this.sessions.set(session.key, session);
      return session;
    } catch (error) {
      await this.forceRemove(name);
      if (volumeCreated) await this.removeVolume(volumeName).catch(() => undefined);
      throw error;
    }
  }

  private async runInSession(
    request: OciRunBatchRequest,
    session: PersistentOciSession,
    sessionReused: boolean
  ): Promise<OciCommandBatchResult> {
    const totalStartedAt = process.hrtime.bigint();
    const uid = process.getuid?.() ?? 65532;
    const gid = process.getgid?.() ?? 65532;
    let forcedRemoval: Promise<void> | undefined;
    const forceRemove = () => {
      forcedRemoval ??= this.forceRemove(session.name);
    };
    const commandStartedAt = process.hrtime.bigint();
    const result = await spawnBounded([
      this.runtime,
      "exec",
      "-i",
      "--workdir",
      "/workspace",
      "--user",
      `${uid}:${gid}`,
      session.name,
      "node",
      "--input-type=module",
      "-e",
      OCI_COMMAND_RUNNER_SCRIPT
    ], {
      env: this.hostEnvironment,
      timeoutMs: request.limits.maxProcessRuntimeMs + OCI_ATTESTATION_TIMEOUT_MS,
      maxOutputBytes: request.limits.maxProcessOutputBytes + OCI_ATTESTATION_PROTOCOL_BYTES,
      input: JSON.stringify({
        commands: request.commands,
        maxProcessRuntimeMs: request.limits.maxProcessRuntimeMs,
        hasDependencies: Boolean(request.dependencyRoot)
      }),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      onStop: forceRemove
    });
    const commandAndAttestationMs = elapsedMilliseconds(commandStartedAt);
    const attestationMatch = result.exitCode === 0
      ? result.stdout.match(OCI_ATTESTATION_PATTERN)
      : null;
    const commandResult = attestationMatch
      ? { ...result, stdout: result.stdout.slice(0, -attestationMatch[0].length) }
      : result;
    if (
      Buffer.byteLength(commandResult.stdout) + Buffer.byteLength(commandResult.stderr) >
      request.limits.maxProcessOutputBytes
    ) {
      commandResult.outputLimitExceeded = true;
    }
    const command = request.commands.length === 1
      ? request.commands[0] as string[]
      : ["<oci-batch>", String(request.commands.length)];
    const backgroundProcess = commandResult.exitCode === 126 && commandResult.stderr.includes(OCI_BACKGROUND_PROCESS_MARKER);
    const commandTimedOut = commandResult.exitCode === 124 && commandResult.stderr.includes(OCI_COMMAND_TIMEOUT_MARKER);
    const attestationFailure = commandResult.exitCode === 127
      ? commandResult.stderr.match(/ZHIVEX_HARNESS_ATTESTATION_FAILURE:([^\r\n]*)/)
      : null;
    if (
      commandResult.exitCode !== 0 ||
      commandResult.timedOut ||
      commandResult.cancelled ||
      commandResult.outputLimitExceeded
    ) {
      forceRemove();
      await forcedRemoval;
      await this.destroySession(session);
      if (attestationFailure) {
        throw new Error(`OCI workspace attestation failed: ${attestationFailure[1] ?? "unknown failure"}.`);
      }
      return {
        ...commandResult,
        command,
        commands: request.commands,
        ...(commandTimedOut ? { timedOut: true, exitCode: 124 } : {}),
        ...(backgroundProcess ? {
          exitCode: 126,
          stderr: [
            commandResult.stderr.replace(OCI_BACKGROUND_PROCESS_MARKER, "").trim(),
            "OCI command left background processes running; its workspace changes were discarded."
          ].filter(Boolean).join("\n")
        } : {}),
        sessionReused,
        workspacePublished: false,
        workspaceExported: false,
        phaseLatencies: {
          commandAndAttestationMs,
          totalMs: elapsedMilliseconds(totalStartedAt)
        }
      };
    }

    try {
      if (!attestationMatch) {
        throw new Error("OCI command attestation returned an invalid workspace seal.");
      }
      const workspaceSeal = attestationMatch[1] as FileDigest;
      if (workspaceSeal === session.snapshotSeal) {
        return {
          ...commandResult,
          command,
          commands: request.commands,
          sessionReused,
          workspacePublished: true,
          workspaceExported: false,
          phaseLatencies: {
            commandAndAttestationMs,
            totalMs: elapsedMilliseconds(totalStartedAt)
          }
        };
      }
      const workspaceExportStartedAt = process.hrtime.bigint();
      const stagedRoot = path.join(path.dirname(request.snapshotRoot), `.workspace-sync-${randomUUID()}`);
      try {
        await privateDirectory(stagedRoot);
        await this.cli(["cp", `${session.name}:/workspace/.`, stagedRoot], 60_000);
        const validated = await validateSynchronizedSnapshot(
          stagedRoot,
          request.snapshotRoot,
          request.limits.maxWorkspaceBytes,
          request.limits.maxFileWriteBytes
        );
        await replaceSnapshot(request.snapshotRoot, stagedRoot);
        session.snapshotSeal = validated.seal;
        session.hostFingerprint = validated.metadataFingerprint;
      } finally {
        await rm(stagedRoot, { recursive: true, force: true });
      }
      return {
        ...commandResult,
        command,
        commands: request.commands,
        sessionReused,
        workspacePublished: true,
        workspaceExported: true,
        phaseLatencies: {
          commandAndAttestationMs,
          workspaceExportMs: elapsedMilliseconds(workspaceExportStartedAt),
          totalMs: elapsedMilliseconds(totalStartedAt)
        }
      };
    } catch (error) {
      await this.destroySession(session);
      throw error;
    }
  }

  private async runBatchLocked(request: OciRunBatchRequest): Promise<OciCommandBatchResult> {
    if (
      request.commands.length === 0 ||
      request.commands.some((command) => command.length === 0)
    ) {
      throw new Error("OCI command batch must contain at least one non-empty argv command.");
    }
    const totalStartedAt = process.hrtime.bigint();
    const key = runHash(request.runId);
    const requestFingerprint = this.requestFingerprint(request);
    let session = this.sessions.get(key);
    let sessionReused = Boolean(session);
    let validated: ValidatedSnapshot | undefined;
    let hostSynchronizationMs: number | undefined;
    let sessionCreationMs: number | undefined;
    if (session) {
      const synchronizationStartedAt = process.hrtime.bigint();
      const hostFingerprint = await snapshotMetadataFingerprint(
        request.snapshotRoot,
        request.limits.maxWorkspaceBytes
      );
      if (
        session.requestFingerprint !== requestFingerprint ||
        session.hostFingerprint !== hostFingerprint
      ) {
        await this.destroySession(session);
        session = undefined;
        sessionReused = false;
      }
      hostSynchronizationMs = elapsedMilliseconds(synchronizationStartedAt);
    }
    if (!session) {
      const creationStartedAt = process.hrtime.bigint();
      validated = await validateSynchronizedSnapshot(
        request.snapshotRoot,
        request.snapshotRoot,
        request.limits.maxWorkspaceBytes,
        request.limits.maxFileWriteBytes
      );
      session = await this.createSession(
        request,
        requestFingerprint,
        validated.seal,
        validated.metadataFingerprint
      );
      sessionCreationMs = elapsedMilliseconds(creationStartedAt);
    }
    try {
      const result = await this.runInSession(request, session, sessionReused);
      return {
        ...result,
        phaseLatencies: {
          ...result.phaseLatencies!,
          ...(hostSynchronizationMs !== undefined ? { hostSynchronizationMs } : {}),
          ...(sessionCreationMs !== undefined ? { sessionCreationMs } : {}),
          totalMs: elapsedMilliseconds(totalStartedAt)
        }
      };
    } catch (error) {
      if (this.sessions.get(key) === session) await this.destroySession(session).catch(() => undefined);
      throw error;
    }
  }

  async run(request: OciRunRequest): Promise<OciCommandResult> {
    const { command, ...shared } = request;
    const result = await this.runBatch({ ...shared, commands: [command] });
    return { ...result, command };
  }

  async runBatch(request: OciRunBatchRequest): Promise<OciCommandBatchResult> {
    return this.withRunLock(request.runId, () => this.runBatchLocked(request));
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

  private async removeRunningOrphans() {
    const listed = await spawnBounded([
      this.runtime,
      "ps",
      "-q",
      "--filter",
      `label=${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
      "--filter",
      "status=running"
    ], {
      env: this.hostEnvironment,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    });
    if (listed.exitCode !== 0) return 0;
    let removed = 0;
    for (const id of validContainerIds(listed.stdout)) {
      const inspected = await this.cli([
        "inspect",
        id,
        "--format",
        "{{json .Config.Labels}}"
      ], 30_000, 20_000);
      const labels = JSON.parse(inspected.stdout) as Record<string, unknown>;
      const ownerPid = Number(labels[HARNESS_OCI_OWNER_PID_LABEL]);
      if (hostProcessIsAlive(ownerPid)) continue;
      await this.forceRemove(id);
      removed += 1;
    }
    return removed;
  }

  async removeRunContainers(runId: string) {
    const key = runHash(runId);
    const session = this.sessions.get(key);
    let cachedResources = 0;
    if (session) {
      await this.destroySession(session);
      cachedResources = 2;
    }
    const filters = [
      `label=${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
      `label=com.zhivex.harness.run=${key}`
    ];
    const containers = await this.removeByFilters(filters);
    const volumes = await this.removeVolumesByFilters(filters);
    return cachedResources + containers + volumes;
  }

  async cleanupOrphans() {
    let removed = 0;
    for (const session of [...this.sessions.values()]) {
      await this.destroySession(session);
      removed += 2;
    }
    this.sessions.clear();
    for (const status of ["created", "exited", "dead", "paused"]) {
      removed += await this.removeByFilters([
        `label=${HARNESS_OCI_LABEL}=${HARNESS_OCI_LABEL_VALUE}`,
        `status=${status}`
      ]);
    }
    removed += await this.removeRunningOrphans();
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
  bytes: number;
}

type SnapshotFileMetadata = Omit<SnapshotFile, "contents">;

export interface HarnessExecutionIoMetrics {
  // Cumulative for one acquired session and surfaced by environment_status.
  inventoryPasses: number;
  inventoryPages: number;
  verifiedContentReads: number;
  verifiedContentBytes: number;
  snapshotFiles: number;
  snapshotBytes: number;
  snapshotCloneFallbacks: number;
  containerStarts: number;
  containerReuses: number;
  workspacePublishes: number;
  workspaceExports: number;
}

const SNAPSHOT_INVENTORY_PAGE_SIZE = 5_000;
const COPY_ON_WRITE_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);

const collectSnapshotInventory = async (
  workspace: Workspace,
  metrics?: HarnessExecutionIoMetrics
): Promise<Map<string, SnapshotFileMetadata>> => {
  const files = new Map<string, SnapshotFileMetadata>();
  if (metrics) metrics.inventoryPasses += 1;
  let cursor: string | undefined;
  do {
    const page = await workspace.listFiles(".", {
      limit: SNAPSHOT_INVENTORY_PAGE_SIZE,
      ...(cursor ? { cursor } : {})
    });
    if (metrics) metrics.inventoryPages += 1;
    for (const file of page.files) {
      const absolute = path.join(workspace.root, ...file.path.split("/"));
      if (!isInside(workspace.root, absolute)) throw new Error(`Snapshot file escaped its workspace: ${file.path}.`);
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Snapshot source is not a regular file: ${file.path}.`);
      }
      if (entry.size !== file.size) {
        throw new Error(`Snapshot source changed while inventorying: ${file.path}.`);
      }
      files.set(file.path, {
        path: file.path,
        digest: file.digest,
        mode: entry.mode & 0o777,
        bytes: file.size
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return files;
};

const readSnapshotFile = async (
  workspace: Workspace,
  expected: SnapshotFileMetadata,
  metrics?: HarnessExecutionIoMetrics
): Promise<SnapshotFile> => {
  // A fresh verified read binds copied/imported bytes to the inventory without
  // retaining every repository file in memory.
  const absolute = path.join(workspace.root, ...expected.path.split("/"));
  if (!isInside(workspace.root, absolute)) {
    throw new Error(`Snapshot file escaped its workspace: ${expected.path}.`);
  }
  const file = await readRegularFileNoFollow(absolute, {
    label: `Snapshot source ${expected.path}`,
    maxBytes: expected.bytes
  });
  const { contents } = file;
  const entry = file.stat;
  const actualDigest = digest(contents);
  if (
    actualDigest !== expected.digest ||
    contents.byteLength !== expected.bytes ||
    (entry.mode & 0o777) !== expected.mode
  ) {
    throw new Error(`Snapshot source changed after inventory: ${expected.path}.`);
  }
  if (metrics) {
    metrics.verifiedContentReads += 1;
    metrics.verifiedContentBytes += contents.byteLength;
  }
  return { ...expected, contents };
};

const copySnapshotFile = async (
  source: string,
  target: string,
  metrics?: HarnessExecutionIoMetrics
) => {
  try {
    await copyFile(source, target, fsConstants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !COPY_ON_WRITE_UNSUPPORTED_CODES.has(code)) throw error;
    if (metrics) metrics.snapshotCloneFallbacks += 1;
    await copyFile(source, target);
  }
};

const copyWorkspaceSnapshot = async (
  source: Workspace,
  baseRoot: string,
  snapshotRoot: string,
  maxWorkspaceBytes: number,
  metrics?: HarnessExecutionIoMetrics
) => {
  const files = await collectSnapshotInventory(source, metrics);
  const totalBytes = [...files.values()].reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > maxWorkspaceBytes) {
    throw new Error(`Workspace snapshot exceeds the ${maxWorkspaceBytes}-byte OCI limit.`);
  }
  for (const root of [baseRoot, snapshotRoot]) {
    await rm(root, { recursive: true, force: true });
    await privateDirectory(root);
  }
  for (const expected of files.values()) {
    const file = await readSnapshotFile(source, expected, metrics);
    const baseTarget = path.join(baseRoot, ...file.path.split("/"));
    const snapshotTarget = path.join(snapshotRoot, ...file.path.split("/"));
    await Promise.all([
      mkdir(path.dirname(baseTarget), { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(snapshotTarget), { recursive: true, mode: 0o700 })
    ]);
    await writeFile(baseTarget, file.contents, { mode: file.mode });
    await chmod(baseTarget, file.mode);
    // copyFile preserves independent-file semantics; COPYFILE_FICLONE_FORCE only
    // makes the mutable workspace's starting copy COW when the filesystem allows it.
    await copySnapshotFile(baseTarget, snapshotTarget, metrics);
    await chmod(snapshotTarget, file.mode);
  }
  if (metrics) {
    metrics.snapshotFiles += files.size;
    metrics.snapshotBytes += totalBytes;
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
  beforeMode?: number;
  afterMode?: number;
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
  maxFileWriteBytes: number,
  metrics?: HarnessExecutionIoMetrics
) => {
  const [before, after] = await Promise.all([
    collectSnapshotInventory(base, metrics),
    collectSnapshotInventory(current, metrics)
  ]);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const entries: EnvironmentPatchEntry[] = [];
  let totalBytes = 0;
  for (const filePath of paths) {
    const oldFile = before.get(filePath);
    const newFile = after.get(filePath);
    if (oldFile?.digest === newFile?.digest && oldFile?.mode === newFile?.mode) continue;
    const operation = !oldFile ? "create" : !newFile ? "delete" : "update";
    const beforeContent = oldFile
      ? textContent(await readSnapshotFile(base, oldFile, metrics), maxFileWriteBytes)
      : undefined;
    const afterContent = newFile
      ? textContent(await readSnapshotFile(current, newFile, metrics), maxFileWriteBytes)
      : undefined;
    const bytes = newFile?.bytes ?? 0;
    totalBytes += bytes;
    entries.push({
      path: filePath,
      operation,
      ...(oldFile ? { beforeDigest: oldFile.digest } : {}),
      ...(oldFile ? { beforeMode: oldFile.mode } : {}),
      ...(beforeContent !== undefined ? { beforeContent } : {}),
      ...(newFile ? { afterDigest: newFile.digest } : {}),
      ...(newFile ? { afterMode: newFile.mode } : {}),
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
  expectedDigest: FileDigest | undefined,
  expectedMode: number | undefined
) => {
  try {
    const current = await workspace.inspectFile(filePath);
    if (!expectedDigest) throw new Error(`Host patch target already exists: ${filePath}.`);
    if (current.digest !== expectedDigest) {
      throw new Error(`Host patch target changed after the environment snapshot: ${filePath}.`);
    }
    if (expectedMode !== undefined && current.mode !== expectedMode) {
      throw new Error(`Host patch target mode changed after the environment snapshot: ${filePath}.`);
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
  maxFileWriteBytes: number,
  metrics?: HarnessExecutionIoMetrics
): Promise<EnvironmentPatchImportResult> => {
  const patch = await createEnvironmentPatch(runId, base, current, maxFileWriteBytes, metrics);
  if (patch.patchId !== expectedPatchId) {
    throw new Error("Environment patch changed after review; inspect it again before import.");
  }
  if (patch.entries.length === 0) throw new Error("Environment patch contains no changes.");
  for (const entry of patch.entries) {
    await inspectHostPrecondition(host, entry.path, entry.beforeDigest, entry.beforeMode);
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
    const modes = new Map(writes.map((entry) => [entry.path, {
      ...(entry.beforeMode !== undefined ? { beforeMode: entry.beforeMode } : {}),
      afterMode: entry.afterMode!
    }]));
    const result = await host.applyPatchWithModes({ proposalId: proposal.proposalId, changes }, modes);
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
        const modes = new Map(updatedWrites.map((entry) => [entry.path, {
          beforeMode: entry.afterMode!,
          afterMode: entry.beforeMode!
        }]));
        await host.applyPatchWithModes({ proposalId: proposal.proposalId, changes }, modes);
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

export interface HarnessEnvironmentStatus {
  schemaVersion: typeof HARNESS_EXECUTION_ARTIFACT_SCHEMA_VERSION;
  kind: "environment-status";
  runId: string;
  binding: AgentExecutionEnvironmentBinding;
  runtime: HarnessOciRuntime;
  runtimeVersion: string;
  imageReference: string;
  imageDigest: string;
  network: "deny";
  rootFilesystem: "read-only";
  workspace: "ephemeral-snapshot";
  patchId: FileDigest;
  changedFiles: number;
  io: HarnessExecutionIoMetrics;
}

export interface HarnessCommandResult extends CommandResult {
  phaseLatencies?: OciPhaseLatencies;
  sessionReused?: boolean;
  workspacePublished?: boolean;
  workspaceExported?: boolean;
}

export interface HarnessExecutionSession extends AgentExecutionEnvironmentSession {
  readonly kind: "zhivex-oci";
  readonly runId: string;
  readonly workspace: Workspace;
  status(): Promise<HarnessEnvironmentStatus>;
  runCommand(command: string, args: readonly string[], context?: ToolExecutionContext): Promise<HarnessCommandResult>;
  runCommandBatch(
    commands: readonly { command: string; args: readonly string[] }[],
    context?: ToolExecutionContext
  ): Promise<HarnessCommandResult>;
  runShell(script: string, context?: ToolExecutionContext): Promise<HarnessCommandResult>;
  runCheck(check: string, expectedScript: string, allowedChecks: readonly string[], context?: ToolExecutionContext): Promise<HarnessCommandResult>;
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
    isolation: "per-run",
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
      process: {
        shell: options.config.shellMode === "ask" ? "allow" : "allowlist",
        allowedCommands: [...options.config.allowedCommands]
      },
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
      containerLifecycle: "warm-per-acquired-run",
      failedCommandRecovery: "discard-and-reseed",
      patchImportApproval: true,
      hostMutationMode: "reviewed-environment-patch",
      shellMode: options.config.shellMode
    }
  };
  const binding = createAgentExecutionEnvironmentBinding(manifest);
  const environmentRoot = path.join(options.stateDirectory, "environments");

  return {
    manifest,
    image,
    runtime,
    async acquire(request: AgentExecutionEnvironmentAcquireRequest) {
      const ioMetrics: HarnessExecutionIoMetrics = {
        inventoryPasses: 0,
        inventoryPages: 0,
        verifiedContentReads: 0,
        verifiedContentBytes: 0,
        snapshotFiles: 0,
        snapshotBytes: 0,
        snapshotCloneFallbacks: 0,
        containerStarts: 0,
        containerReuses: 0,
        workspacePublishes: 0,
        workspaceExports: 0
      };
      await privateDirectory(environmentRoot);
      const directory = path.join(environmentRoot, runHash(request.runId));
      await privateDirectory(directory);
      const metadataPath = path.join(directory, "environment.json");
      const baseRoot = path.join(directory, "base");
      const snapshotRoot = path.join(directory, "workspace");
      let metadata: EnvironmentMetadata;
      try {
        const metadataFile = await readRegularFileNoFollow(metadataPath, {
          label: "Execution metadata",
          maxBytes: 1024 * 1024
        });
        metadata = JSON.parse(metadataFile.contents.toString("utf8")) as EnvironmentMetadata;
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
          options.config.maxWorkspaceBytes,
          ioMetrics
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
      const validateCommand = (command: string, args: readonly string[]) => {
        if (!options.config.allowedCommands.includes(command)) {
          throw new Error(`The OCI command "${command}" is not in the explicit allowlist.`);
        }
        if (args.length > 256 || args.some((value) => value.length > 8_192 || value.includes("\0"))) {
          throw new Error("OCI command arguments exceed the bounded argument contract.");
        }
        return [command, ...args] as string[];
      };
      const sharedRunRequest = (context?: ToolExecutionContext) => ({
          runId: request.runId,
          snapshotRoot,
          ...(dependencyRoot ? { dependencyRoot } : {}),
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
      const normalizeResult = (result: OciCommandResult): HarnessCommandResult => {
        if (result.sessionReused === false) ioMetrics.containerStarts += 1;
        if (result.sessionReused === true) ioMetrics.containerReuses += 1;
        if (result.workspacePublished === true) ioMetrics.workspacePublishes += 1;
        if (result.workspaceExported === true) ioMetrics.workspaceExports += 1;
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
          timedOut: result.timedOut,
          ...(result.phaseLatencies ? { phaseLatencies: result.phaseLatencies } : {}),
          ...(result.sessionReused !== undefined ? { sessionReused: result.sessionReused } : {}),
          ...(result.workspacePublished !== undefined ? { workspacePublished: result.workspacePublished } : {}),
          ...(result.workspaceExported !== undefined ? { workspaceExported: result.workspaceExported } : {})
        };
      };
      const runCommand = async (
        command: string,
        args: readonly string[],
        context?: ToolExecutionContext
      ) => normalizeResult(await runtime.run({
        ...sharedRunRequest(context),
        command: validateCommand(command, args)
      }));
      const runCommandBatch = async (
        commands: readonly { command: string; args: readonly string[] }[],
        context?: ToolExecutionContext
      ): Promise<HarnessCommandResult> => {
        if (commands.length === 0 || commands.length > 32) {
          throw new Error("OCI command batch must contain between 1 and 32 commands.");
        }
        if (commands.reduce((total, item) => total + item.args.length, 0) > 256) {
          throw new Error("OCI command batch exceeds the bounded argument-count contract.");
        }
        const argvCommands = commands.map(({ command, args }) => validateCommand(command, args));
        if (runtime.runBatch) {
          return normalizeResult(await runtime.runBatch({
            ...sharedRunRequest(context),
            commands: argvCommands
          }));
        }
        const results: HarnessCommandResult[] = [];
        for (const argv of argvCommands) {
          const result = await runCommand(argv[0] as string, argv.slice(1), context);
          results.push(result);
          if (result.exitCode !== 0) break;
        }
        return {
          command: ["<oci-batch>", String(commands.length)],
          exitCode: results.at(-1)?.exitCode ?? 1,
          stdout: results.map((result) => result.stdout).filter(Boolean).join(""),
          stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
          timedOut: results.some((result) => result.timedOut)
        };
      };
      const runShell = async (
        script: string,
        context?: ToolExecutionContext
      ): Promise<HarnessCommandResult> => {
        if (options.config.shellMode !== "ask") {
          throw new Error("OCI shell execution is denied by policy.");
        }
        if (!script || script.length > 16_384 || script.includes("\0")) {
          throw new Error("OCI shell script must contain between 1 and 16384 characters without NUL bytes.");
        }
        return normalizeResult(await runtime.run({
          ...sharedRunRequest(context),
          command: ["sh", "-lc", script, "zhivex-harness"]
        }));
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
          if (name === "run_environment_shell") {
            const input = authorization.input as { script?: unknown };
            if (
              options.config.shellMode !== "ask" ||
              typeof input.script !== "string" ||
              input.script.length < 1 ||
              input.script.length > 16_384 ||
              input.script.includes("\0")
            ) {
              return { decision: "deny", reason: "OCI shell execution is denied or the script is invalid." };
            }
          }
          if (name === "verify_and_apply_environment_patch" || name === "verify_and_apply_reviewed_edits") {
            const input = authorization.input as {
              command?: unknown;
              args?: unknown;
              patchId?: unknown;
              changes?: unknown;
            };
            const validBoundInput = name === "verify_and_apply_environment_patch"
              ? typeof input.patchId === "string"
              : Array.isArray(input.changes) && input.changes.length > 0;
            if (
              !validBoundInput ||
              typeof input.command !== "string" ||
              !options.config.allowedCommands.includes(input.command) ||
              !Array.isArray(input.args)
            ) {
              return { decision: "deny", reason: "The verified OCI transaction is invalid or contains a non-allowlisted executable." };
            }
          }
          if (name === "run_environment_batch") {
            const input = authorization.input as { commands?: unknown };
            if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 32 ||
              input.commands.some((item) => {
                const candidate = item as { command?: unknown; args?: unknown };
                return typeof candidate.command !== "string" ||
                  !options.config.allowedCommands.includes(candidate.command) ||
                  !Array.isArray(candidate.args);
              })) {
              return { decision: "deny", reason: "The requested OCI command batch is invalid or contains a non-allowlisted executable." };
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
          const patch = await createEnvironmentPatch(
            request.runId,
            base,
            workspace,
            options.config.maxFileWriteBytes,
            ioMetrics
          );
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
            changedFiles: patch.entries.length,
            io: { ...ioMetrics }
          };
        },
        runCommand,
        runCommandBatch,
        runShell,
        async runCheck(check, expectedScript, allowedChecks, context) {
          let manifestDocument: { packageManager?: unknown; scripts?: unknown };
          try {
            const manifestFile = await readRegularFileNoFollow(path.join(snapshotRoot, "package.json"), {
              label: "Snapshot package.json",
              maxBytes: 1024 * 1024
            });
            manifestDocument = JSON.parse(manifestFile.contents.toString("utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error("The environment snapshot does not contain package.json.");
            }
            throw error;
          }
          const resolved = await resolvePackageCheckCommand(
            snapshotRoot,
            manifestDocument,
            check,
            expectedScript,
            allowedChecks
          );
          return runCommand(resolved.command[0], resolved.command.slice(1), context);
        },
        async inspectPatch() {
          const patch = await createEnvironmentPatch(
            request.runId,
            base,
            workspace,
            options.config.maxFileWriteBytes,
            ioMetrics
          );
          const payload = patchPayload(request.runId, patch.entries);
          return {
            ...payload,
            patchId: patch.patchId,
            totalBytes: patch.totalBytes
          };
        },
        importPatch(host, patchId) {
          return importPatch(
            request.runId,
            patchId,
            host,
            base,
            workspace,
            options.config.maxFileWriteBytes,
            ioMetrics
          );
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
    const stagedMatch = STAGED_EXECUTION_ARTIFACT_DIRECTORY_PATTERN.exec(entry.name);
    const artifactName = EXECUTION_ARTIFACT_DIRECTORY_PATTERN.test(entry.name)
      ? entry.name
      : stagedMatch?.[1];
    if (!entry.isDirectory() || entry.isSymbolicLink() || !artifactName) {
      result.skipped += 1;
      continue;
    }
    result.scanned += 1;
    const directory = path.join(root, entry.name);
    try {
      const resolved = await realpath(directory);
      if (!isInside(root, resolved)) throw new Error("unsafe execution artifact directory");
      const directoryEntry = await lstat(directory);
      if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
        throw new Error("unsafe execution artifact directory");
      }
      const metadataPath = path.join(directory, "environment.json");
      const metadataFile = await readRegularFileNoFollow(metadataPath, {
        label: "Execution cleanup metadata",
        maxBytes: 1024 * 1024
      });
      const metadata = JSON.parse(metadataFile.contents.toString("utf8")) as EnvironmentMetadata;
      const releasedAt = metadata.releasedAt ? Date.parse(metadata.releasedAt) : Number.NaN;
      if (!metadata.status || !TERMINAL_STATUSES.has(metadata.status) || !Number.isFinite(releasedAt) || releasedAt >= before) {
        result.skipped += 1;
        continue;
      }

      const stagedDirectory = path.join(root, `.cleanup-${artifactName}-${randomUUID()}`);
      let staged = false;
      try {
        await rename(directory, stagedDirectory);
        staged = true;
        const movedEntry = await lstat(stagedDirectory);
        if (
          movedEntry.isSymbolicLink() ||
          !movedEntry.isDirectory() ||
          movedEntry.dev !== directoryEntry.dev ||
          movedEntry.ino !== directoryEntry.ino
        ) {
          throw new Error("execution artifact directory changed before cleanup");
        }
        const recheckedMetadata = await readRegularFileNoFollow(
          path.join(stagedDirectory, "environment.json"),
          { label: "Execution cleanup metadata", maxBytes: 1024 * 1024 }
        );
        if (!recheckedMetadata.contents.equals(metadataFile.contents)) {
          throw new Error("execution artifact metadata changed before cleanup");
        }
        await rm(stagedDirectory, { recursive: true, force: true });
        staged = false;
        result.deleted += 1;
      } catch (error) {
        if (staged) await rename(stagedDirectory, directory).catch(() => undefined);
        throw error;
      }
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
