import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".zhivex-harness",
  "coverage",
  "dist",
  "node_modules"
]);

const isSensitiveName = (name: string) =>
  name === ".env" ||
  (name.startsWith(".env.") && name !== ".env.example") ||
  name === ".npmrc" ||
  name === "id_rsa" ||
  name === "id_ed25519" ||
  name.endsWith(".key") ||
  name.endsWith(".pem") ||
  name.endsWith(".p12") ||
  name.endsWith(".pfx");

const shouldIgnoreEntry = (name: string) => DEFAULT_IGNORES.has(name) || isSensitiveName(name);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT = 20_000;

export type HarnessCheck = "test" | "typecheck" | "lint" | "build";

export interface WorkspaceFile {
  path: string;
  size: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface CommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const truncate = (value: string, maxLength = MAX_TOOL_OUTPUT) =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n… output truncated (${value.length - maxLength} characters omitted)`;

const decodeTextFile = async (filePath: string) => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("The path does not point to a regular file.");
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error(`The file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
  }
  const contents = await readFile(filePath);
  if (contents.includes(0)) {
    throw new Error("The file appears to be binary and cannot be read as text.");
  }
  return contents.toString("utf8");
};

const spawnBounded = async (
  command: string[],
  cwd: string,
  timeoutMs = 120_000
): Promise<CommandResult> => {
  const allowedEnvironmentKeys = [
    "CI",
    "FORCE_COLOR",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR"
  ];
  const environment = Object.fromEntries(
    allowedEnvironmentKeys.flatMap((key) => process.env[key] ? [[key, process.env[key] as string]] : [])
  );
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    return {
      command,
      exitCode,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      timedOut
    };
  } finally {
    clearTimeout(timeout);
  }
};

export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<Workspace> {
    const resolved = await realpath(path.resolve(root));
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      throw new Error(`The workspace is not a directory: ${root}`);
    }
    return new Workspace(resolved);
  }

  private lexicalPath(relativePath: string) {
    if (!relativePath || relativePath.includes("\0")) {
      throw new Error("The path must be a valid relative path.");
    }
    const candidate = path.resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) {
      throw new Error(`The path escapes the workspace: ${relativePath}`);
    }
    const segments = path.relative(this.root, candidate).split(path.sep).filter(Boolean);
    const blockedSegment = segments.find((segment) => shouldIgnoreEntry(segment));
    if (blockedSegment) {
      throw new Error(`The path is protected by the harness policy: ${blockedSegment}`);
    }
    return candidate;
  }

  private async existingPath(relativePath: string) {
    const candidate = this.lexicalPath(relativePath);
    const resolved = await realpath(candidate);
    if (!isInside(this.root, resolved)) {
      throw new Error(`The path resolves outside the workspace: ${relativePath}`);
    }
    return resolved;
  }

  private async writablePath(relativePath: string) {
    const candidate = this.lexicalPath(relativePath);
    if (candidate === this.root) {
      throw new Error("The workspace root cannot be overwritten.");
    }

    let ancestor = candidate;
    for (;;) {
      try {
        const resolved = await realpath(ancestor);
        if (!isInside(this.root, resolved)) {
          throw new Error(`The path resolves outside the workspace: ${relativePath}`);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new Error(`Could not resolve a safe path for: ${relativePath}`);
        }
        ancestor = parent;
      }
    }
    return candidate;
  }

  async listFiles(relativePath = ".", maxEntries = 200): Promise<{ files: WorkspaceFile[]; truncated: boolean }> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 5000) {
      throw new Error("maxEntries must be between 1 and 5000.");
    }
    const start = await this.existingPath(relativePath);
    const startStat = await stat(start);
    if (!startStat.isDirectory()) {
      throw new Error("list_files requires a directory.");
    }

    const files: WorkspaceFile[] = [];
    const pending = [start];
    let truncatedResult = false;

    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) {
        break;
      }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name)
      );

      for (const entry of entries) {
        if (shouldIgnoreEntry(entry.name) || entry.isSymbolicLink()) {
          continue;
        }
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const entryStat = await stat(entryPath);
        files.push({
          path: path.relative(this.root, entryPath),
          size: entryStat.size
        });
        if (files.length >= maxEntries) {
          truncatedResult = pending.length > 0 || entries.indexOf(entry) < entries.length - 1;
          return { files: files.sort((left, right) => left.path.localeCompare(right.path)), truncated: truncatedResult };
        }
      }
    }

    return { files: files.sort((left, right) => left.path.localeCompare(right.path)), truncated: false };
  }

  async readFile(relativePath: string, startLine = 1, endLine?: number) {
    if (!Number.isSafeInteger(startLine) || startLine < 1) {
      throw new Error("startLine must be a positive integer.");
    }
    if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine)) {
      throw new Error("endLine must be greater than or equal to startLine.");
    }
    const resolved = await this.existingPath(relativePath);
    const contents = await decodeTextFile(resolved);
    const lines = contents.split(/\r?\n/);
    const boundedEnd = Math.min(endLine ?? startLine + 399, startLine + 1999, lines.length);
    const selected = lines.slice(startLine - 1, boundedEnd);
    return {
      path: path.relative(this.root, resolved),
      startLine,
      endLine: boundedEnd,
      totalLines: lines.length,
      content: selected.map((line, index) => `${startLine + index}: ${line}`).join("\n"),
      truncated: boundedEnd < lines.length
    };
  }

  async searchFiles(
    query: string,
    relativePath = ".",
    options: { caseSensitive?: boolean; maxMatches?: number } = {}
  ) {
    if (!query || query.length > 200) {
      throw new Error("The search query must be between 1 and 200 characters.");
    }
    const maxMatches = options.maxMatches ?? 100;
    if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 500) {
      throw new Error("maxMatches must be between 1 and 500.");
    }

    const { files, truncated: filesTruncated } = await this.listFiles(relativePath, 5000);
    const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
    const matches: SearchMatch[] = [];

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        continue;
      }
      let contents: string;
      try {
        contents = await decodeTextFile(path.join(this.root, file.path));
      } catch {
        continue;
      }
      const lines = contents.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
        if (haystack.includes(needle)) {
          matches.push({ path: file.path, line: index + 1, text: truncate(line, 500) });
          if (matches.length >= maxMatches) {
            return { matches, truncated: true };
          }
        }
      }
    }

    return { matches, truncated: filesTruncated };
  }

  async writeFile(relativePath: string, content: string, overwrite = false) {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new Error(`The content exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    }
    const target = await this.writablePath(relativePath);
    try {
      const current = await lstat(target);
      if (current.isSymbolicLink()) {
        throw new Error("Writing through a symbolic link is not allowed.");
      }
      if (!overwrite) {
        throw new Error("The file already exists; set overwrite=true or use replace_in_file.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", mode: 0o644 });
    return { path: path.relative(this.root, target), bytes: Buffer.byteLength(content), overwritten: overwrite };
  }

  async replaceInFile(relativePath: string, oldText: string, newText: string) {
    if (!oldText) {
      throw new Error("oldText cannot be empty.");
    }
    const target = await this.existingPath(relativePath);
    const contents = await decodeTextFile(target);
    const occurrences = contents.split(oldText).length - 1;
    if (occurrences !== 1) {
      throw new Error(`oldText must occur exactly once; found ${occurrences} occurrences.`);
    }
    const updated = contents.replace(oldText, newText);
    if (Buffer.byteLength(updated) > MAX_FILE_BYTES) {
      throw new Error(`The result exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    }
    await writeFile(target, updated, { encoding: "utf8", mode: 0o644 });
    return {
      path: path.relative(this.root, target),
      beforeBytes: Buffer.byteLength(contents),
      afterBytes: Buffer.byteLength(updated)
    };
  }

  async runCheck(check: HarnessCheck, expectedScript: string): Promise<CommandResult> {
    const packagePath = path.join(this.root, "package.json");
    let scripts: Record<string, string> = {};
    try {
      const packageJson = JSON.parse(await decodeTextFile(packagePath)) as { scripts?: Record<string, string> };
      scripts = packageJson.scripts ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("The workspace does not contain a package.json file.");
      }
      throw error;
    }

    if (!scripts[check]) {
      throw new Error(`package.json does not define the \"${check}\" script.`);
    }
    if (scripts[check] !== expectedScript) {
      throw new Error(`The \"${check}\" script changed or does not match expectedScript.`);
    }
    return spawnBounded(["bun", "--no-env-file", "run", check], this.root);
  }

  async gitDiff(): Promise<{ status: CommandResult; diff: CommandResult }> {
    const [statusResult, diffResult] = await Promise.all([
      spawnBounded(["git", "status", "--short"], this.root, 15_000),
      spawnBounded(["git", "diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], this.root, 15_000)
    ]);
    return { status: statusResult, diff: diffResult };
  }
}
