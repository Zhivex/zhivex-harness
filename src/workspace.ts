import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  createEditProposal,
  moveFileInputSchema,
  quarantineFileInputSchema,
  restoreFileInputSchema,
  validateEditProposal,
  type ApplyEditProposalInput,
  type ApplyPatchResult,
  type FileDigest,
  type MoveFileInput,
  type MoveFileResult,
  type MutationAuditEntry,
  type QuarantineFileInput,
  type QuarantineFileResult,
  type RestoreFileInput,
  type RestoreFileResult
} from "./edit-contracts.js";
import { resolvePackageCheckCommand } from "./package-manager.js";
import { runPortableProcess } from "./process-runtime.js";

const HARD_IGNORES = new Set([".git", ".next", ".turbo", ".zhivex-harness", "coverage", "dist", "node_modules"]);
const IGNORE_FILES = [".gitignore", ".zhivex-harnessignore"] as const;
const DEFAULT_CHECKS = ["test", "typecheck", "lint", "build"] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_READ_BATCH_FILES = 20;
const MAX_READ_BATCH_BYTES = 2 * MAX_FILE_BYTES;
const MAX_SEARCH_MANY_QUERIES = 10;
const MAX_SEARCH_MANY_MATCHES = 500;

const isSensitiveName = (name: string) => {
  const normalized = name.toLocaleLowerCase();
  return normalized === ".env" ||
    (normalized.startsWith(".env.") && normalized !== ".env.example") ||
    normalized === ".npmrc" ||
    normalized === "id_rsa" ||
    normalized === "id_ed25519" ||
    normalized.endsWith(".key") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".p12") ||
    normalized.endsWith(".pfx");
};

const isHardIgnored = (relativePath: string) =>
  relativePath.split("/").some((segment) => HARD_IGNORES.has(segment.toLocaleLowerCase()) || isSensitiveName(segment));

export type HarnessCheck = string;

export interface WorkspaceFile {
  path: string;
  size: number;
  digest: FileDigest;
}

export interface WorkspaceTopologyFile {
  path: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  digest: FileDigest;
}

export interface ListFilesOptions {
  limit?: number;
  cursor?: string;
  /**
   * Set to false to enumerate paths without reading file contents. Digest-bound
   * listings remain the default; edits still require a separately observed digest.
   */
  includeDigests?: boolean;
}

export interface ListFilesResult<TFile extends WorkspaceFile | WorkspaceTopologyFile = WorkspaceFile> {
  files: TFile[];
  truncated: boolean;
  nextCursor?: string;
}

export interface SearchFilesOptions {
  caseSensitive?: boolean;
  limit?: number;
  cursor?: string;
  /** @deprecated Use limit. */
  maxMatches?: number;
}

export interface CommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface IgnoreRule {
  base: string;
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

interface CollectedFile {
  path: string;
}

interface EntryFingerprint {
  path: string;
  kind: "directory" | "ignore-file";
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest?: FileDigest;
}

interface WorkspaceIndex {
  version: string;
  files: readonly CollectedFile[];
  directories: readonly EntryFingerprint[];
  ignoreFiles: readonly EntryFingerprint[];
}

interface StableFile {
  path: string;
  absolutePath: string;
  contents: Buffer;
  digest: FileDigest;
  mode: number;
}

interface ListCursor {
  v: 2;
  kind: "list";
  path: string;
  limit: number;
  includeDigests: boolean;
  after: string;
  indexVersion: string;
}

interface SearchCursor {
  v: 2;
  kind: "search";
  path: string;
  query: string;
  caseSensitive: boolean;
  limit: number;
  afterPath: string;
  afterLine: number;
  indexVersion: string;
}

export interface ReadFilesRequest {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface SearchManyQuery {
  query: string;
  caseSensitive?: boolean;
}

export interface SearchManyOptions {
  limitPerQuery?: number;
}

export interface WorkspaceIndexDiagnostics {
  builds: number;
  reuses: number;
  stableFileReads: number;
  version?: string;
  files: number;
  directories: number;
}

interface QuarantineManifest {
  schemaVersion: 1;
  quarantineId: string;
  originalPath: string;
  digest: FileDigest;
  mode: number;
  status: "quarantined" | "restored";
  createdAt: string;
  restoredAt?: string;
  restoredPath?: string;
}

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const wirePath = (value: string) => value.split(path.sep).join("/");
const digestBytes = (value: string | Uint8Array): FileDigest =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const truncate = (value: string, maxLength = MAX_TOOL_OUTPUT) =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n… output truncated (${value.length - maxLength} characters omitted)`;
const cursorEncode = (value: ListCursor | SearchCursor) => Buffer.from(JSON.stringify(value)).toString("base64url");
const cursorDecode = (value: string): unknown => {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("The pagination cursor is invalid.");
  }
};

const firstPathAtLeast = (files: readonly CollectedFile[], target: string) => {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((files[middle]?.path ?? "") < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const firstPathAfter = (files: readonly CollectedFile[], target: string) => {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((files[middle]?.path ?? "") <= target) low = middle + 1;
    else high = middle;
  }
  return low;
};

const escapeRegex = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
const globRegex = (pattern: string) => {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
};

const parseIgnoreRules = (contents: string, base: string): IgnoreRule[] => {
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    if (!line) continue;
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const source = globRegex(line);
    rules.push({
      base,
      negated,
      directoryOnly,
      regex: anchored || line.includes("/") ? new RegExp(`^${source}$`) : new RegExp(`(?:^|/)${source}$`)
    });
  }
  return rules;
};

const isIgnoredByRules = (relativePath: string, isDirectory: boolean, rules: readonly IgnoreRule[]) => {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    const local = rule.base
      ? relativePath === rule.base
        ? ""
        : relativePath.startsWith(`${rule.base}/`)
          ? relativePath.slice(rule.base.length + 1)
          : undefined
      : relativePath;
    if (local && rule.regex.test(local)) ignored = !rule.negated;
  }
  return ignored;
};

const spawnBounded = async (command: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> => {
  return await runPortableProcess(command, { cwd, timeoutMs });
};

export class Workspace {
  readonly root: string;
  private readonly auditEntries: MutationAuditEntry[] = [];
  private readonly indexIdentity = randomUUID();
  private indexRevision = 0;
  private workspaceIndex: WorkspaceIndex | undefined;
  private indexBuild: { revision: number; promise: Promise<WorkspaceIndex> } | undefined;
  private readonly indexMetrics = { builds: 0, reuses: 0, stableFileReads: 0 };

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<Workspace> {
    const resolved = await realpath(path.resolve(root));
    if (!(await stat(resolved)).isDirectory()) throw new Error(`The workspace is not a directory: ${root}`);
    return new Workspace(resolved);
  }

  private lexicalPath(relativePath: string) {
    if (!relativePath || relativePath.includes("\0")) throw new Error("The path must be a valid relative path.");
    const candidate = path.resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) throw new Error(`The path escapes the workspace: ${relativePath}`);
    const relative = wirePath(path.relative(this.root, candidate));
    if (relative && isHardIgnored(relative)) {
      const blocked = relative.split("/").find((segment) => HARD_IGNORES.has(segment.toLocaleLowerCase()) || isSensitiveName(segment));
      throw new Error(`The path is protected by the harness policy: ${blocked}`);
    }
    return candidate;
  }

  private async safePath(relativePath: string, options: { requireFile?: boolean; allowMissing?: boolean } = {}) {
    const candidate = this.lexicalPath(relativePath);
    if (candidate === this.root && options.requireFile) throw new Error("The workspace root is not a regular file.");
    const segments = path.relative(this.root, candidate).split(path.sep).filter(Boolean);
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index] as string);
      let entry;
      try {
        entry = await lstat(current);
      } catch (error) {
        if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return { path: candidate, exists: false as const };
        }
        throw error;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`The path resolves outside the workspace or through a symbolic link: ${relativePath}`);
      }
      const leaf = index === segments.length - 1;
      if (!leaf && !entry.isDirectory()) throw new Error(`A path ancestor is not a directory: ${relativePath}`);
      if (leaf && options.requireFile && !entry.isFile()) throw new Error("The path does not point to a regular file.");
    }
    return { path: candidate, exists: true as const };
  }

  private async readStableFile(relativePath: string, allowBinary = true): Promise<StableFile> {
    this.indexMetrics.stableFileReads += 1;
    const safe = await this.safePath(relativePath, { requireFile: true });
    const before = await lstat(safe.path);
    if (before.size > MAX_FILE_BYTES) throw new Error(`The file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    const contents = await readFile(safe.path);
    const after = await lstat(safe.path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`The file changed while it was being read: ${relativePath}`);
    }
    if (!allowBinary && contents.includes(0)) throw new Error("The file appears to be binary and cannot be read as text.");
    return {
      path: wirePath(path.relative(this.root, safe.path)),
      absolutePath: safe.path,
      contents,
      digest: digestBytes(contents),
      mode: before.mode & 0o777
    };
  }

  private fingerprint(
    relativePath: string,
    kind: EntryFingerprint["kind"],
    entry: Stats,
    digest?: FileDigest
  ): EntryFingerprint {
    return {
      path: relativePath || ".",
      kind,
      dev: entry.dev,
      ino: entry.ino,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      ...(digest ? { digest } : {})
    };
  }

  private sameFingerprint(entry: Stats, fingerprint: EntryFingerprint) {
    return entry.dev === fingerprint.dev && entry.ino === fingerprint.ino && entry.size === fingerprint.size &&
      entry.mtimeMs === fingerprint.mtimeMs && entry.ctimeMs === fingerprint.ctimeMs;
  }

  private async rulesForDirectory(
    directory: string,
    base: string,
    inherited: readonly IgnoreRule[],
    ignoreFiles: EntryFingerprint[]
  ) {
    const rules = [...inherited];
    for (const filename of IGNORE_FILES) {
      try {
        const ignorePath = path.join(directory, filename);
        const before = await lstat(ignorePath);
        if (before.isSymbolicLink() || !before.isFile()) continue;
        if (before.size <= MAX_FILE_BYTES) {
          const contents = await readFile(ignorePath);
          const after = await lstat(ignorePath);
          if (after.isSymbolicLink() || !after.isFile() || !this.sameFingerprint(after, this.fingerprint("", "ignore-file", before))) {
            throw new Error(`The ignore file changed while the workspace was being indexed: ${wirePath(path.relative(this.root, ignorePath))}`);
          }
          const digest = digestBytes(contents);
          ignoreFiles.push(this.fingerprint(wirePath(path.relative(this.root, ignorePath)), "ignore-file", after, digest));
          rules.push(...parseIgnoreRules(contents.toString("utf8"), base));
        } else {
          ignoreFiles.push(this.fingerprint(wirePath(path.relative(this.root, ignorePath)), "ignore-file", before));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return rules;
  }

  private async collectFiles(version: string): Promise<WorkspaceIndex> {
    const files: CollectedFile[] = [];
    const directories: EntryFingerprint[] = [];
    const ignoreFiles: EntryFingerprint[] = [];
    const walk = async (directory: string, base: string, inherited: readonly IgnoreRule[]) => {
      const directoryEntry = await lstat(directory);
      if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
        throw new Error(`A workspace directory changed while it was being indexed: ${base || "."}`);
      }
      directories.push(this.fingerprint(base, "directory", directoryEntry));
      const rules = await this.rulesForDirectory(directory, base, inherited, ignoreFiles);
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        const relative = base ? `${base}/${entry.name}` : entry.name;
        if (isHardIgnored(relative) || entry.isSymbolicLink() || isIgnoredByRules(relative, entry.isDirectory(), rules)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute, relative, rules);
        else if (entry.isFile()) files.push({ path: relative });
      }
    };
    await walk(this.root, "", []);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { version, files, directories, ignoreFiles };
  }

  private async isWorkspaceIndexFresh(index: WorkspaceIndex) {
    try {
      for (const fingerprint of index.directories) {
        const absolute = fingerprint.path === "." ? this.root : path.join(this.root, fingerprint.path);
        const entry = await lstat(absolute);
        if (entry.isSymbolicLink() || !entry.isDirectory() || !this.sameFingerprint(entry, fingerprint)) return false;
      }
      for (const fingerprint of index.ignoreFiles) {
        const absolute = path.join(this.root, fingerprint.path);
        const before = await lstat(absolute);
        if (before.isSymbolicLink() || !before.isFile() || !this.sameFingerprint(before, fingerprint)) return false;
        if (fingerprint.digest) {
          const contents = await readFile(absolute);
          const after = await lstat(absolute);
          if (after.isSymbolicLink() || !after.isFile() || !this.sameFingerprint(after, fingerprint) ||
            digestBytes(contents) !== fingerprint.digest) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private invalidateWorkspaceIndex() {
    this.indexRevision += 1;
    this.workspaceIndex = undefined;
  }

  private async buildWorkspaceIndex(revision: number) {
    const version = `${this.indexIdentity}:${revision}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const index = await this.collectFiles(version);
        if (await this.isWorkspaceIndexFresh(index)) return index;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const changedDuringIndexing = error instanceof Error && error.message.includes("while the workspace was being indexed");
        if (attempt === 2 || (code !== "ENOENT" && !changedDuringIndexing)) throw error;
      }
    }
    throw new Error("The workspace kept changing while its file index was being built.");
  }

  private async getWorkspaceIndex(): Promise<WorkspaceIndex> {
    const cached = this.workspaceIndex;
    if (cached) {
      if (await this.isWorkspaceIndexFresh(cached)) {
        this.indexMetrics.reuses += 1;
        return cached;
      }
      this.invalidateWorkspaceIndex();
    }
    const revision = this.indexRevision;
    if (!this.indexBuild || this.indexBuild.revision !== revision) {
      const promise = this.buildWorkspaceIndex(revision);
      this.indexBuild = { revision, promise };
    }
    const build = this.indexBuild;
    let index: WorkspaceIndex;
    try {
      index = await build.promise;
    } catch (error) {
      if (this.indexBuild === build) this.indexBuild = undefined;
      throw error;
    }
    if (revision !== this.indexRevision) return this.getWorkspaceIndex();
    if (this.indexBuild === build) this.indexBuild = undefined;
    if (this.workspaceIndex?.version !== index.version) {
      this.workspaceIndex = index;
      this.indexMetrics.builds += 1;
    }
    return this.workspaceIndex;
  }

  workspaceIndexDiagnostics(): WorkspaceIndexDiagnostics {
    const index = this.workspaceIndex;
    return {
      ...this.indexMetrics,
      ...(index ? { version: index.version } : {}),
      files: index?.files.length ?? 0,
      directories: index?.directories.length ?? 0
    };
  }

  async listFiles(
    relativePath: string,
    options: ListFilesOptions & { includeDigests: false }
  ): Promise<ListFilesResult<WorkspaceTopologyFile>>;
  async listFiles(
    relativePath?: string,
    options?: number | (ListFilesOptions & { includeDigests?: true })
  ): Promise<ListFilesResult<WorkspaceFile>>;
  async listFiles(
    relativePath: string,
    options: ListFilesOptions
  ): Promise<ListFilesResult<WorkspaceFile | WorkspaceTopologyFile>>;
  async listFiles(
    relativePath = ".",
    options: number | ListFilesOptions = {}
  ): Promise<ListFilesResult<WorkspaceFile | WorkspaceTopologyFile>> {
    const start = await this.safePath(relativePath);
    if (!(await lstat(start.path)).isDirectory()) throw new Error("list_files requires a directory.");
    const requestPath = wirePath(path.relative(this.root, start.path)) || ".";
    const input = typeof options === "number" ? { limit: options } : options;
    const limit = input.limit ?? 200;
    const includeDigests = input.includeDigests ?? true;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("limit must be between 1 and 5000.");
    let after = "";
    let cursorIndexVersion: string | undefined;
    if (input.cursor) {
      const parsed = cursorDecode(input.cursor) as Partial<ListCursor>;
      if (parsed.v !== 2 || parsed.kind !== "list" || parsed.path !== requestPath || parsed.limit !== limit ||
        parsed.includeDigests !== includeDigests || typeof parsed.indexVersion !== "string" ||
        typeof parsed.after !== "string") {
        throw new Error("The pagination cursor does not match this list request.");
      }
      after = parsed.after;
      cursorIndexVersion = parsed.indexVersion;
    }
    const index = await this.getWorkspaceIndex();
    if (cursorIndexVersion && cursorIndexVersion !== index.version) {
      throw new Error("The pagination cursor is stale because the workspace changed.");
    }
    const prefix = requestPath === "." ? "" : `${requestPath}/`;
    let candidateIndex = after
      ? firstPathAfter(index.files, after)
      : requestPath === "."
        ? 0
        : firstPathAtLeast(index.files, prefix);
    const selected: CollectedFile[] = [];
    while (candidateIndex < index.files.length && selected.length <= limit) {
      const candidate = index.files[candidateIndex];
      if (!candidate || (requestPath !== "." && !candidate.path.startsWith(prefix))) break;
      selected.push(candidate);
      candidateIndex += 1;
    }
    const truncated = selected.length > limit;
    if (truncated) selected.pop();
    const files: Array<WorkspaceFile | WorkspaceTopologyFile> = [];
    if (includeDigests) {
      for (const candidate of selected) {
        const file = await this.readStableFile(candidate.path);
        files.push({ path: file.path, size: file.contents.byteLength, digest: file.digest });
      }
    } else {
      files.push(...selected.map(({ path: candidatePath }) => ({ path: candidatePath })));
    }
    const last = selected.at(-1);
    return {
      files,
      truncated,
      ...(truncated && last ? {
        nextCursor: cursorEncode({
          v: 2,
          kind: "list",
          path: requestPath,
          limit,
          includeDigests,
          after: last.path,
          indexVersion: index.version
        })
      } : {})
    };
  }

  private renderReadFile(file: StableFile, startLine = 1, endLine?: number) {
    if (!Number.isSafeInteger(startLine) || startLine < 1) throw new Error("startLine must be a positive integer.");
    if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine)) {
      throw new Error("endLine must be greater than or equal to startLine.");
    }
    const lines = file.contents.toString("utf8").split(/\r?\n/);
    const boundedEnd = Math.min(endLine ?? startLine + 399, startLine + 1999, lines.length);
    return {
      path: file.path,
      digest: file.digest,
      startLine,
      endLine: boundedEnd,
      totalLines: lines.length,
      content: lines.slice(startLine - 1, boundedEnd).map((line, index) => `${startLine + index}: ${line}`).join("\n"),
      truncated: boundedEnd < lines.length
    };
  }

  async readFile(relativePath: string, startLine = 1, endLine?: number) {
    return this.renderReadFile(await this.readStableFile(relativePath, false), startLine, endLine);
  }

  async readFiles(requests: readonly ReadFilesRequest[]) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_READ_BATCH_FILES) {
      throw new Error(`readFiles requires between 1 and ${MAX_READ_BATCH_FILES} file requests.`);
    }
    const ordered = requests.map((request) => ({
      ...request,
      path: wirePath(path.relative(this.root, this.lexicalPath(request.path)))
    })).sort((a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.startLine ?? 1) - (b.startLine ?? 1) || (a.endLine ?? 0) - (b.endLine ?? 0));
    const stableFiles = new Map<string, StableFile>();
    let totalBytes = 0;
    for (const request of ordered) {
      if (!Number.isSafeInteger(request.startLine ?? 1) || (request.startLine ?? 1) < 1 ||
        (request.endLine !== undefined && (!Number.isSafeInteger(request.endLine) || request.endLine < (request.startLine ?? 1)))) {
        throw new Error(`Invalid line range for ${request.path}.`);
      }
      if (stableFiles.has(request.path)) continue;
      const file = await this.readStableFile(request.path, false);
      totalBytes += file.contents.byteLength;
      if (totalBytes > MAX_READ_BATCH_BYTES) {
        throw new Error(`readFiles exceeds the aggregate ${MAX_READ_BATCH_BYTES}-byte source limit.`);
      }
      stableFiles.set(request.path, file);
    }
    return {
      files: ordered.map((request) => this.renderReadFile(
        stableFiles.get(request.path) as StableFile,
        request.startLine ?? 1,
        request.endLine
      )),
      sourceBytes: totalBytes
    };
  }

  async inspectFile(relativePath: string) {
    const file = await this.readStableFile(relativePath);
    return {
      path: file.path,
      digest: file.digest,
      mode: file.mode,
      bytes: file.contents.byteLength
    };
  }

  async searchFiles(query: string, relativePath = ".", options: SearchFilesOptions = {}) {
    if (!query || query.length > 200) throw new Error("The search query must be between 1 and 200 characters.");
    const start = await this.safePath(relativePath);
    if (!(await lstat(start.path)).isDirectory()) throw new Error("search_files requires a directory.");
    const requestPath = wirePath(path.relative(this.root, start.path)) || ".";
    const limit = options.limit ?? options.maxMatches ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500.");
    const caseSensitive = options.caseSensitive ?? false;
    let afterPath = "";
    let afterLine = 0;
    let cursorIndexVersion: string | undefined;
    if (options.cursor) {
      const parsed = cursorDecode(options.cursor) as Partial<SearchCursor>;
      if (parsed.v !== 2 || parsed.kind !== "search" || parsed.path !== requestPath || parsed.query !== query ||
        parsed.caseSensitive !== caseSensitive || parsed.limit !== limit || typeof parsed.afterPath !== "string" ||
        !Number.isSafeInteger(parsed.afterLine) || typeof parsed.indexVersion !== "string") {
        throw new Error("The pagination cursor does not match this search request.");
      }
      afterPath = parsed.afterPath;
      afterLine = parsed.afterLine as number;
      cursorIndexVersion = parsed.indexVersion;
    }
    const index = await this.getWorkspaceIndex();
    if (cursorIndexVersion && cursorIndexVersion !== index.version) {
      throw new Error("The pagination cursor is stale because the workspace changed.");
    }
    const prefix = requestPath === "." ? "" : `${requestPath}/`;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const matches: SearchMatch[] = [];
    let hasMore = false;
    let candidateIndex = afterPath
      ? firstPathAtLeast(index.files, afterPath)
      : requestPath === "."
        ? 0
        : firstPathAtLeast(index.files, prefix);
    for (; candidateIndex < index.files.length; candidateIndex += 1) {
      const candidate = index.files[candidateIndex];
      if (!candidate || (requestPath !== "." && !candidate.path.startsWith(prefix))) break;
      let file: StableFile;
      try {
        file = await this.readStableFile(candidate.path, false);
      } catch {
        continue;
      }
      const lines = file.contents.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const lineNumber = index + 1;
        if (candidate.path === afterPath && lineNumber <= afterLine) continue;
        const line = lines[index] ?? "";
        if (!(caseSensitive ? line : line.toLocaleLowerCase()).includes(needle)) continue;
        if (matches.length >= limit) {
          hasMore = true;
          break;
        }
        matches.push({ path: candidate.path, line: lineNumber, text: truncate(line, 500), digest: file.digest });
      }
      if (hasMore) break;
    }
    const last = matches.at(-1);
    return {
      matches,
      truncated: hasMore,
      ...(hasMore && last ? {
        nextCursor: cursorEncode({
          v: 2,
          kind: "search",
          path: requestPath,
          query,
          caseSensitive,
          limit,
          afterPath: last.path,
          afterLine: last.line,
          indexVersion: index.version
        })
      } : {})
    };
  }

  async searchMany(queries: readonly SearchManyQuery[], relativePath = ".", options: SearchManyOptions = {}) {
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_SEARCH_MANY_QUERIES) {
      throw new Error(`searchMany requires between 1 and ${MAX_SEARCH_MANY_QUERIES} queries.`);
    }
    const limitPerQuery = options.limitPerQuery ?? 50;
    if (!Number.isSafeInteger(limitPerQuery) || limitPerQuery < 1 || limitPerQuery > MAX_SEARCH_MANY_MATCHES ||
      limitPerQuery * queries.length > MAX_SEARCH_MANY_MATCHES) {
      throw new Error(`searchMany allows at most ${MAX_SEARCH_MANY_MATCHES} aggregate matches.`);
    }
    const seen = new Set<string>();
    const states = queries.map((input) => {
      if (!input.query || input.query.length > 200) throw new Error("Each search query must be between 1 and 200 characters.");
      const caseSensitive = input.caseSensitive ?? false;
      const key = `${caseSensitive ? "1" : "0"}\0${input.query}`;
      if (seen.has(key)) throw new Error("searchMany queries must be unique.");
      seen.add(key);
      return {
        query: input.query,
        caseSensitive,
        needle: caseSensitive ? input.query : input.query.toLocaleLowerCase(),
        matches: [] as SearchMatch[],
        truncated: false
      };
    });
    const start = await this.safePath(relativePath);
    if (!(await lstat(start.path)).isDirectory()) throw new Error("searchMany requires a directory.");
    const requestPath = wirePath(path.relative(this.root, start.path)) || ".";
    const prefix = requestPath === "." ? "" : `${requestPath}/`;
    const index = await this.getWorkspaceIndex();
    let candidateIndex = requestPath === "." ? 0 : firstPathAtLeast(index.files, prefix);
    for (; candidateIndex < index.files.length; candidateIndex += 1) {
      const candidate = index.files[candidateIndex];
      if (!candidate || (requestPath !== "." && !candidate.path.startsWith(prefix))) break;
      let file: StableFile;
      try {
        file = await this.readStableFile(candidate.path, false);
      } catch {
        continue;
      }
      const lines = file.contents.toString("utf8").split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const foldedLine = line.toLocaleLowerCase();
        for (const state of states) {
          if (state.truncated || !(state.caseSensitive ? line : foldedLine).includes(state.needle)) continue;
          if (state.matches.length >= limitPerQuery) {
            state.truncated = true;
            continue;
          }
          state.matches.push({
            path: candidate.path,
            line: lineIndex + 1,
            text: truncate(line, 500),
            digest: file.digest
          });
        }
      }
      if (states.every((state) => state.truncated)) break;
    }
    return {
      results: states.map(({ needle: _needle, ...state }) => state)
    };
  }

  private audit(entry: Omit<MutationAuditEntry, "id" | "timestamp">): MutationAuditEntry {
    const record = { id: randomUUID(), timestamp: new Date().toISOString(), ...entry } as MutationAuditEntry;
    this.auditEntries.push(record);
    return record;
  }

  mutationAudit(): readonly MutationAuditEntry[] {
    return this.auditEntries.map((entry) => ({ ...entry }));
  }

  private async secureWorkspaceDirectory(directory: string, mode = 0o755) {
    const resolvedInput = path.resolve(directory);
    if (!isInside(this.root, resolvedInput)) {
      throw new Error("A mutation directory escapes the workspace.");
    }
    const segments = path.relative(this.root, resolvedInput).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) throw new Error("A mutation directory must not contain a symbolic link.");
        if (!entry.isDirectory()) throw new Error("A mutation directory contains a non-directory entry.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await mkdir(current, { mode });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          const raced = await lstat(current);
          if (raced.isSymbolicLink() || !raced.isDirectory()) {
            throw new Error("A mutation directory changed during creation.");
          }
        }
      }
    }
    const canonical = await realpath(current);
    if (!isInside(this.root, canonical)) throw new Error("A mutation directory resolves outside the workspace.");
    return canonical;
  }

  private async stageFile(target: string, contents: string | Uint8Array, mode: number) {
    const directory = await this.secureWorkspaceDirectory(path.dirname(target));
    const temporary = path.join(directory, `.${path.basename(target)}.zhivex-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(contents);
      await handle.chmod(mode);
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await handle.close();
    return temporary;
  }

  async applyPatch(input: ApplyEditProposalInput): Promise<ApplyPatchResult> {
    return this.applyPatchWithModes(input, new Map());
  }

  async applyPatchWithModes(
    input: ApplyEditProposalInput,
    modes: ReadonlyMap<string, { beforeMode?: number; afterMode: number }>
  ): Promise<ApplyPatchResult> {
    const proposal = validateEditProposal(input);
    const targetPaths = new Set(proposal.changes.map((change) => change.path));
    for (const [targetPath, binding] of modes) {
      if (!targetPaths.has(targetPath)) {
        throw new Error(`Patch mode binding has no matching content target: ${targetPath}.`);
      }
      for (const [label, mode] of [["before", binding.beforeMode], ["after", binding.afterMode]] as const) {
        if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)) {
          throw new Error(`Patch ${label} mode must be an integer between 0 and 0777: ${targetPath}.`);
        }
      }
    }
    const ordered = [...proposal.changes].sort((a, b) => a.path < b.path ? -1 : 1);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous && current && current.path.startsWith(`${previous.path}/`)) {
        throw new Error(`Patch targets conflict as ancestor and descendant: ${previous.path}, ${current.path}.`);
      }
    }
    const prepared: Array<{
      change: (typeof proposal.changes)[number];
      target: string;
      before?: StableFile;
      modeBinding?: { beforeMode?: number; afterMode: number };
      temporary: string;
    }> = [];
    try {
      for (const change of proposal.changes) {
        const safe = await this.safePath(change.path, { allowMissing: true });
        const modeBinding = modes.get(change.path);
        let before: StableFile | undefined;
        if (change.expectedDigest === null) {
          if (safe.exists) throw new Error(`The patch target already exists: ${change.path}.`);
          if (modeBinding?.beforeMode !== undefined) {
            throw new Error(`Create-only patch mode binding cannot declare a before mode: ${change.path}.`);
          }
        } else {
          if (!safe.exists) throw new Error(`The patch target no longer exists: ${change.path}.`);
          before = await this.readStableFile(change.path);
          if (before.digest !== change.expectedDigest) {
            throw new Error(`Stale patch rejected for ${change.path}: expected ${change.expectedDigest}, found ${before.digest}.`);
          }
          if (modeBinding?.beforeMode !== undefined && before.mode !== modeBinding.beforeMode) {
            throw new Error(`Stale patch mode rejected for ${change.path}: expected ${modeBinding.beforeMode.toString(8)}, found ${before.mode.toString(8)}.`);
          }
        }
        const temporary = await this.stageFile(
          safe.path,
          change.content,
          modeBinding?.afterMode ?? before?.mode ?? 0o644
        );
        prepared.push({
          change,
          target: safe.path,
          ...(before ? { before } : {}),
          ...(modeBinding ? { modeBinding } : {}),
          temporary
        });
      }
    } catch (error) {
      await Promise.all(prepared.map((item) => unlink(item.temporary).catch(() => {})));
      throw error;
    }
    const committed: typeof prepared = [];
    try {
      for (const item of prepared) {
        await this.safePath(item.change.path, { allowMissing: item.change.expectedDigest === null });
        if (item.before) {
          const current = await this.readStableFile(item.change.path);
          if (current.digest !== item.change.expectedDigest) throw new Error(`Stale patch rejected for ${item.change.path}.`);
          if (item.modeBinding?.beforeMode !== undefined && current.mode !== item.modeBinding.beforeMode) {
            throw new Error(`Stale patch mode rejected for ${item.change.path}.`);
          }
          await rename(item.temporary, item.target);
        } else {
          try {
            await link(item.temporary, item.target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error(`The patch target was created concurrently: ${item.change.path}.`);
            }
            throw error;
          }
          await unlink(item.temporary);
        }
        committed.push(item);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const item of [...committed].reverse()) {
        try {
          if (item.before) {
            const rollback = await this.stageFile(item.target, item.before.contents, item.before.mode);
            await rename(rollback, item.target);
          } else {
            await unlink(item.target);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      await Promise.all(prepared.map((item) => unlink(item.temporary).catch(() => {})));
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Patch failed and rollback was incomplete.");
      throw error;
    }
    this.invalidateWorkspaceIndex();
    const changes = prepared.map((item) => this.audit({
      operation: item.before ? "update" : "create",
      path: item.change.path,
      ...(item.before ? { beforeDigest: item.before.digest } : {}),
      afterDigest: digestBytes(item.change.content)
    }));
    return { proposalId: proposal.proposalId, changes };
  }

  /** @deprecated Use applyPatch with an inspected expectedDigest. */
  async writeFile(relativePath: string, content: string, overwrite = false) {
    const safe = await this.safePath(relativePath, { allowMissing: true });
    if (safe.exists && !overwrite) throw new Error("The file already exists; use applyPatch with its expected digest.");
    const before = safe.exists ? await this.readStableFile(relativePath) : undefined;
    const changes = [{ path: relativePath, expectedDigest: before?.digest ?? null, content }];
    const proposal = createEditProposal({ changes });
    await this.applyPatch({ proposalId: proposal.proposalId, changes });
    return { path: relativePath, bytes: Buffer.byteLength(content), overwritten: Boolean(before) };
  }

  /** @deprecated Use applyPatch with an inspected expectedDigest. */
  async replaceInFile(relativePath: string, oldText: string, newText: string) {
    if (!oldText) throw new Error("oldText cannot be empty.");
    const before = await this.readStableFile(relativePath, false);
    const contents = before.contents.toString("utf8");
    const occurrences = contents.split(oldText).length - 1;
    if (occurrences !== 1) throw new Error(`oldText must occur exactly once; found ${occurrences} occurrences.`);
    const updated = contents.replace(oldText, newText);
    const changes = [{ path: relativePath, expectedDigest: before.digest, content: updated }];
    const proposal = createEditProposal({ changes });
    await this.applyPatch({ proposalId: proposal.proposalId, changes });
    return { path: relativePath, beforeBytes: before.contents.byteLength, afterBytes: Buffer.byteLength(updated) };
  }

  async moveFile(input: MoveFileInput): Promise<MoveFileResult> {
    const parsed = moveFileInputSchema.parse(input);
    const source = await this.readStableFile(parsed.source);
    if (source.digest !== parsed.expectedDigest) throw new Error(`Stale move rejected for ${parsed.source}.`);
    const destination = await this.safePath(parsed.destination, { allowMissing: true });
    if (destination.exists) throw new Error(`Move destination already exists: ${parsed.destination}.`);
    await this.secureWorkspaceDirectory(path.dirname(destination.path));
    const destinationRecheck = await this.safePath(parsed.destination, { allowMissing: true });
    if (destinationRecheck.exists) throw new Error(`Move destination already exists: ${parsed.destination}.`);
    if ((await this.readStableFile(parsed.source)).digest !== parsed.expectedDigest) throw new Error(`Stale move rejected for ${parsed.source}.`);
    let linked = false;
    try {
      await link(source.absolutePath, destination.path);
      linked = true;
      const linkedFile = await this.readStableFile(parsed.destination);
      if (linkedFile.digest !== source.digest) {
        throw new Error(`Move destination changed before commit: ${parsed.destination}.`);
      }
      await unlink(source.absolutePath);
    } catch (error) {
      if (linked) await unlink(destination.path).catch(() => {});
      throw error;
    }
    this.invalidateWorkspaceIndex();
    const audit = this.audit({ operation: "move", path: parsed.source, destination: parsed.destination, beforeDigest: source.digest, afterDigest: source.digest });
    return { source: parsed.source, destination: parsed.destination, digest: source.digest, audit };
  }

  private async secureQuarantineDirectory(create: boolean) {
    const segments = [".zhivex-harness", "quarantine"];
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) {
          throw new Error("Harness quarantine must not resolve through a symbolic link.");
        }
        if (!entry.isDirectory()) {
          throw new Error("Harness quarantine path contains a non-directory entry.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          const racedEntry = await lstat(current);
          if (racedEntry.isSymbolicLink() || !racedEntry.isDirectory()) {
            throw new Error("Harness quarantine path changed during creation.");
          }
        }
      }
    }
    const resolved = await realpath(current);
    if (!isInside(this.root, resolved)) throw new Error("Harness quarantine resolves outside the workspace.");
    return resolved;
  }

  private async writeManifest(manifest: QuarantineManifest) {
    const directory = await this.secureQuarantineDirectory(true);
    const target = path.join(directory, `${manifest.quarantineId}.json`);
    const temporary = await this.stageFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    await rename(temporary, target);
  }

  private async readInternalRegularFile(target: string, label: string, maxBytes: number) {
    const before = await lstat(target);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds its size limit.`);
    const contents = await readFile(target);
    const after = await lstat(target);
    if (after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return { contents, stat: before };
  }

  async quarantineFile(input: QuarantineFileInput): Promise<QuarantineFileResult> {
    const parsed = quarantineFileInputSchema.parse(input);
    const source = await this.readStableFile(parsed.path);
    if (source.digest !== parsed.expectedDigest) throw new Error(`Stale quarantine rejected for ${parsed.path}.`);
    const quarantineId = `${Date.now()}-${randomUUID()}`;
    const directory = await this.secureQuarantineDirectory(true);
    const dataPath = path.join(directory, `${quarantineId}.data`);
    if ((await this.readStableFile(parsed.path)).digest !== parsed.expectedDigest) throw new Error(`Stale quarantine rejected for ${parsed.path}.`);
    await link(source.absolutePath, dataPath);
    if (digestBytes(await readFile(dataPath)) !== source.digest) {
      await unlink(dataPath).catch(() => {});
      throw new Error(`Quarantine payload changed before commit: ${parsed.path}.`);
    }
    const manifest: QuarantineManifest = {
      schemaVersion: 1,
      quarantineId,
      originalPath: parsed.path,
      digest: source.digest,
      mode: source.mode,
      status: "quarantined",
      createdAt: new Date().toISOString()
    };
    try {
      await this.writeManifest(manifest);
      await unlink(source.absolutePath);
    } catch (error) {
      await unlink(dataPath).catch(() => {});
      await unlink(path.join(directory, `${quarantineId}.json`)).catch(() => {});
      throw error;
    }
    this.invalidateWorkspaceIndex();
    const audit = this.audit({ operation: "quarantine", path: parsed.path, beforeDigest: source.digest, quarantineId });
    return { quarantineId, path: parsed.path, digest: source.digest, audit };
  }

  async restoreQuarantined(input: RestoreFileInput): Promise<RestoreFileResult> {
    const parsed = restoreFileInputSchema.parse(input);
    const directory = await this.secureQuarantineDirectory(false);
    let manifest: QuarantineManifest;
    try {
      const manifestFile = await this.readInternalRegularFile(
        path.join(directory, `${parsed.quarantineId}.json`),
        "Quarantine manifest",
        64 * 1024
      );
      manifest = JSON.parse(manifestFile.contents.toString("utf8")) as QuarantineManifest;
    } catch {
      throw new Error(`Quarantine entry was not found: ${parsed.quarantineId}.`);
    }
    if (manifest.schemaVersion !== 1 || manifest.quarantineId !== parsed.quarantineId || manifest.status !== "quarantined") {
      throw new Error(`Quarantine entry is not restorable: ${parsed.quarantineId}.`);
    }
    const dataPath = path.join(directory, `${parsed.quarantineId}.data`);
    const dataFile = await this.readInternalRegularFile(dataPath, "Quarantine payload", MAX_FILE_BYTES);
    const digest = digestBytes(dataFile.contents);
    if (digest !== manifest.digest || (parsed.expectedDigest && parsed.expectedDigest !== digest)) {
      throw new Error(`Quarantine digest mismatch: ${parsed.quarantineId}.`);
    }
    const destinationPath = parsed.destination ?? manifest.originalPath;
    const destination = await this.safePath(destinationPath, { allowMissing: true });
    if (destination.exists) throw new Error(`Restore destination already exists: ${destinationPath}.`);
    await this.secureWorkspaceDirectory(path.dirname(destination.path));
    const destinationRecheck = await this.safePath(destinationPath, { allowMissing: true });
    if (destinationRecheck.exists) throw new Error(`Restore destination already exists: ${destinationPath}.`);
    const dataRecheck = await lstat(dataPath);
    if (dataRecheck.isSymbolicLink() || !dataRecheck.isFile() || dataRecheck.dev !== dataFile.stat.dev ||
      dataRecheck.ino !== dataFile.stat.ino || dataRecheck.size !== dataFile.stat.size ||
      dataRecheck.mtimeMs !== dataFile.stat.mtimeMs) {
      throw new Error("Quarantine payload changed before restore commit.");
    }
    await link(dataPath, destination.path);
    const linkedDestination = await lstat(destination.path);
    if (linkedDestination.isSymbolicLink() || !linkedDestination.isFile() || linkedDestination.dev !== dataFile.stat.dev ||
      linkedDestination.ino !== dataFile.stat.ino || digestBytes(await readFile(destination.path)) !== digest) {
      await unlink(destination.path).catch(() => {});
      throw new Error("Restore destination did not match the quarantined payload.");
    }
    const restoredManifest: QuarantineManifest = {
      ...manifest,
      status: "restored",
      restoredAt: new Date().toISOString(),
      restoredPath: destinationPath
    };
    try {
      await this.writeManifest(restoredManifest);
    } catch (error) {
      await unlink(destination.path).catch(() => {});
      throw error;
    }
    try {
      await unlink(dataPath);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        await this.writeManifest(manifest);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        await unlink(destination.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      throw rollbackErrors.length
        ? new AggregateError([error, ...rollbackErrors], "Restore failed and rollback was incomplete.")
        : error;
    }
    this.invalidateWorkspaceIndex();
    const audit = this.audit({ operation: "restore", path: destinationPath, afterDigest: digest, quarantineId: parsed.quarantineId });
    return { quarantineId: parsed.quarantineId, path: destinationPath, digest, audit };
  }

  async runCheck(check: HarnessCheck, expectedScript: string, allowedChecks: readonly string[] = DEFAULT_CHECKS): Promise<CommandResult> {
    let manifest: { packageManager?: unknown; scripts?: unknown };
    try {
      manifest = JSON.parse(
        (await this.readStableFile("package.json", false)).contents.toString("utf8")
      ) as { packageManager?: unknown; scripts?: unknown };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("The workspace does not contain a package.json file.");
      throw error;
    }
    const resolved = await resolvePackageCheckCommand(
      this.root,
      manifest,
      check,
      expectedScript,
      allowedChecks
    );
    try {
      return await spawnBounded(resolved.command, this.root);
    } finally {
      this.invalidateWorkspaceIndex();
    }
  }

  async gitDiff(): Promise<{ status: CommandResult; diff: CommandResult; staged: CommandResult }> {
    const [statusResult, diffResult, stagedResult] = await Promise.all([
      spawnBounded(["git", "status", "--short", "--untracked-files=all"], this.root, 15_000),
      spawnBounded(["git", "diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], this.root, 15_000),
      spawnBounded(["git", "diff", "--cached", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], this.root, 15_000)
    ]);
    return { status: statusResult, diff: diffResult, staged: stagedResult };
  }
}
