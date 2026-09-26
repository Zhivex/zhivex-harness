import path from "node:path";
import { lstat, opendir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FileSizeLimitError, readRegularFileNoFollow } from "../workspace/file-security.js";

export const dependencyReadSchema = z.object({
  package: z.string().max(160).regex(/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/),
  action: z.enum(["read", "list", "search"]).default("read"),
  file: z.string().max(4096).default("package.json").describe("Package-relative file for action=read; discover paths with action=list."),
  path: z.string().max(4096).default(".").describe("Package-relative directory for list/search. Never include node_modules or the package name."),
  query: z.string().min(1).max(1000).optional().describe("Literal text for search, or optional path filter for list."),
  recursive: z.boolean().default(false).describe("List subdirectories recursively; search is always recursive."),
  caseSensitive: z.boolean().default(false),
  startLine: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
});

type DependencyInput = z.input<typeof dependencyReadSchema>;
type DependencyReadResult = {
  package: string; file: string; startLine: number; content: string; digest: string; truncated: boolean;
};
type DependencyPage = {
  package: string; path: string; skippedFiles: number; truncated: boolean;
  nextOffset: number | null; notice?: string;
};
type DependencyListResult = DependencyPage & {
  action: "list"; entries: { path: string; type: "file" | "directory" }[];
};
type DependencySearchResult = DependencyPage & {
  action: "search"; matches: { file: string; line: number; text: string }[];
};
type DependencyResult = DependencyReadResult | DependencyListResult | DependencySearchResult;

type DirectoryIdentity = { target: string; dev: number; ino: number; ctimeMs: number };
const MAX_ENTRIES = 20000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 16000;

function relativeSegments(value: string, directory = false): string[] {
  if (directory && value === ".") return [];
  const segments = value.split("/");
  if (segments.some(p => !p || p === "." || p === ".." || p.startsWith(".") || p === "node_modules" || p.includes("\\") || p.includes("\0"))) {
    throw new Error("Dependency paths must be package-relative; hidden paths, traversal, nested node_modules and links are not allowed. Use action=list to discover available paths.");
  }
  return segments;
}

async function directoryIdentity(target: string): Promise<DirectoryIdentity> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Dependency directory links are not allowed.");
  return { target, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

async function verifyDirectories(entries: readonly DirectoryIdentity[]) {
  for (const entry of entries) {
    const current = await directoryIdentity(entry.target);
    if (current.dev !== entry.dev || current.ino !== entry.ino || current.ctimeMs !== entry.ctimeMs)
      throw new Error("Dependency directory changed during inspection. Retry after dependency installation finishes.");
  }
}

async function checkedDirectories(root: string, segments: readonly string[]) {
  const directories = [await directoryIdentity(root)];
  let target = root;
  for (const segment of segments) {
    target = path.join(target, segment);
    directories.push(await directoryIdentity(target));
  }
  return { target, directories };
}

function decodeText(contents: Buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  if (text.includes("\0")) throw new Error("Dependency file must be UTF-8 text, not binary data.");
  return text;
}

/** Dedicated read-only package boundary. Reads never execute source, follow links,
 * enter nested dependencies or expose hidden files. Content reads are descriptor-bound. */
export function readDependency(root: string, input: DependencyInput & { action?: "read" }): Promise<DependencyReadResult>;
export function readDependency(root: string, input: DependencyInput & { action: "list" }): Promise<DependencyListResult>;
export function readDependency(root: string, input: DependencyInput & { action: "search" }): Promise<DependencySearchResult>;
export function readDependency(root: string, input: DependencyInput): Promise<DependencyResult>;
export async function readDependency(root: string, input: DependencyInput): Promise<DependencyResult> {
  const args = dependencyReadSchema.parse(input);
  const name = args.package;
  try {
    const baseSegments = ["node_modules", ...name.split("/")];
    if (args.action === "read") {
      const segments = relativeSegments(args.file);
      const { target, directories } = await checkedDirectories(root, [...baseSegments, ...segments.slice(0, -1)]);
      const result = await readRegularFileNoFollow(path.join(target, segments.at(-1)!), {
        label: "Dependency file", maxBytes: MAX_FILE_BYTES, requireSingleLink: true
      });
      await verifyDirectories(directories);
      const lines = decodeText(result.contents).split("\n");
      const slice = lines.slice(args.startLine - 1, args.startLine + 199).join("\n");
      const content = slice.slice(0, MAX_OUTPUT_CHARS);
      return { package: name, file: args.file, startLine: args.startLine, content,
        digest: "sha256:" + createHash("sha256").update(result.contents).digest("hex"),
        truncated: args.startLine + 199 < lines.length || slice.length > content.length };
    }
    if (args.action === "search" && !args.query) throw new Error("action=search requires a literal query. Use action=list to discover file names.");
    const start = relativeSegments(args.path, true);
    const { target: base, directories } = await checkedDirectories(root, [...baseSegments, ...start]);
    const entries: { path: string; type: "file" | "directory" }[] = [];
    const matches: { file: string; line: number; text: string }[] = [];
    let visited = 0, found = 0, outputChars = 0, bytes = 0, skippedFiles = 0;
    let exhausted = false, more = false;
    const query = args.caseSensitive ? args.query : args.query?.toLowerCase();
    const resultCount = () => args.action === "list" ? entries.length : matches.length;
    const add = (value: { path: string; type: "file" | "directory" } | { file: string; line: number; text: string }) => {
      if (found++ < args.offset) return;
      const size = JSON.stringify(value).length;
      if (resultCount() >= args.limit || outputChars + size > MAX_OUTPUT_CHARS) {
        if (resultCount() === 0) exhausted = true;
        else more = true;
        return;
      }
      outputChars += size;
      if ("path" in value) entries.push(value); else matches.push(value);
    };
    const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
      if (depth > 40) { exhausted = true; return; }
      const identity = await directoryIdentity(directory);
      // Keep enumeration bounded before sorting, including directories with huge fanout.
      const children: string[] = [];
      const handle = await opendir(directory);
      for await (const child of handle) {
        if (++visited > MAX_ENTRIES) { exhausted = true; break; }
        if (child.name.startsWith(".") || child.name === "node_modules" || child.name.includes("\\")) continue;
        children.push(child.name);
      }
      await verifyDirectories([...directories, identity]);
      for (const child of children.sort()) {
        const childPath = path.join(directory, child);
        const childRelative = relative ? `${relative}/${child}` : child;
        const stat = await lstat(childPath);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) { skippedFiles++; continue; }
        if (args.action === "list") {
          if (!query || (args.caseSensitive ? childRelative : childRelative.toLowerCase()).includes(query))
            add({ path: childRelative, type: stat.isDirectory() ? "directory" : "file" });
        } else if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES) { skippedFiles++; continue; }
          if (bytes + stat.size > MAX_SEARCH_BYTES) { exhausted = true; break; }
          const result = await readRegularFileNoFollow(childPath, { label: "Dependency file", maxBytes: MAX_FILE_BYTES, requireSingleLink: true });
          if (bytes + result.contents.length > MAX_SEARCH_BYTES) { exhausted = true; break; }
          bytes += result.contents.length;
          let text: string;
          try { text = decodeText(result.contents); } catch { skippedFiles++; continue; }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if ((args.caseSensitive ? line : line.toLowerCase()).includes(query!)) add({ file: childRelative, line: i + 1, text: line.slice(0, 1000) });
            if (more) break;
          }
        }
        if (more) break;
        if (stat.isDirectory() && (args.recursive || args.action === "search")) await walk(childPath, childRelative, depth + 1);
        if (more || exhausted) break;
      }
      await verifyDirectories([...directories, identity]);
    };
    await walk(base, start.join("/"), 0);
    await verifyDirectories(directories);
    const page: DependencyPage = { package: name, path: args.path,
      skippedFiles, truncated: more || exhausted,
      nextOffset: more ? args.offset + resultCount() : null,
      ...(exhausted ? { notice: "Inspection budget reached. Narrow path or query to inspect the remaining package files." } : {}) };
    return args.action === "list" ? { ...page, action: "list", entries } : { ...page, action: "search", matches };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { await lstat(path.join(root, "node_modules", ...name.split("/"))); }
      catch (packageError) {
        if ((packageError as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(`Dependency ${name} is not installed in this workspace's node_modules. Check package.json and the package manager installation before inspecting it.`);
        throw packageError;
      }
      throw new Error(`Dependency path was not found in ${name}. Use read_dependency with action=list and path=. to discover actual package-relative paths; discover paths before reading them.`);
    }
    if (error instanceof FileSizeLimitError)
      throw new Error("Dependency file exceeds the 1 MiB inspection limit. List the package and select a smaller source or declaration file.");
    throw error;
  }
}
