import { constants as fsConstants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export interface StableRegularFile {
  contents: Buffer;
  stat: Stats;
}

export interface ReadRegularFileNoFollowOptions {
  label: string;
  maxBytes: number;
  requireSingleLink?: boolean;
}

const sameOpenFile = (before: Stats, after: Stats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs &&
  before.mode === after.mode &&
  before.nlink === after.nlink;

export class UnsafeFileTypeError extends Error {
  constructor(label: string) {
    super(`${label} must be a regular file and must not be a symbolic link.`);
    this.name = "UnsafeFileTypeError";
  }
}

export class FileSizeLimitError extends Error {
  constructor(
    readonly label: string,
    readonly maxBytes: number
  ) {
    super(`${label} exceeds the ${maxBytes}-byte limit.`);
    this.name = "FileSizeLimitError";
  }
}

export class FileChangedWhileReadingError extends Error {
  constructor(label: string) {
    super(`${label} changed while it was being read.`);
    this.name = "FileChangedWhileReadingError";
  }
}

const invalidFileError = (label: string) => new UnsafeFileTypeError(label);

const openRegularFileNoFollow = async (target: string, label: string) => {
  try {
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    let absolute = path.resolve(target);
    if (process.platform === "darwin") {
      // Darwin's O_NOFOLLOW_ANY is enforced by namei for the entire path.
      // Only canonicalize the OS-owned aliases; never realpath user ancestors.
      absolute = absolute.replace(/^\/(tmp|var|etc)(\/|$)/, "/private/$1$2");
      return await open(absolute, (flags & ~fsConstants.O_NOFOLLOW) | 0x20000000);
    }
    if (process.platform !== "linux") throw new Error("Safe descriptor-relative reads require Linux or macOS.");
    const segments = absolute.split("/").filter(Boolean);
    const leaf = segments.pop();
    if (!leaf) throw invalidFileError(label);
    let directory = await open("/", fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      for (const segment of segments) {
        // procfs resolves only the trusted descriptor. Each untrusted child is
        // opened separately without following links, even if a parent is renamed.
        const next = await open(`/proc/self/fd/${directory.fd}/${segment}`,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      return await open(`/proc/self/fd/${directory.fd}/${leaf}`, flags);
    } finally { await directory.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK" || code === "ENOTDIR") throw invalidFileError(label);
    throw error;
  }
};

export const statRegularFileNoFollow = async (
  target: string,
  options: Pick<ReadRegularFileNoFollowOptions, "label" | "requireSingleLink">
): Promise<Stats> => {
  const handle = await openRegularFileNoFollow(target, options.label);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (options.requireSingleLink && stat.nlink !== 1)) {
      throw invalidFileError(options.label);
    }
    return stat;
  } finally {
    await handle.close();
  }
};

/**
 * Opens the leaf without following a symbolic link and performs every content
 * and identity check through the resulting descriptor. Positional reads bind
 * the returned bytes to the exact inode that was opened, avoiding path-based
 * time-of-check/time-of-use windows.
 */
export const readRegularFileNoFollow = async (
  target: string,
  options: ReadRegularFileNoFollowOptions
): Promise<StableRegularFile> => {
  const handle = await openRegularFileNoFollow(target, options.label);

  try {
    const before = await handle.stat();
    if (!before.isFile() || (options.requireSingleLink && before.nlink !== 1)) {
      throw invalidFileError(options.label);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new Error(`${options.label} has an unsupported size.`);
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
      throw new Error(`${options.label} has an invalid byte limit.`);
    }
    if (before.size > options.maxBytes) {
      throw new FileSizeLimitError(options.label, options.maxBytes);
    }

    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.byteLength - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, before.size);
    const after = await handle.stat();
    if (
      offset !== before.size ||
      extraBytes !== 0 ||
      !sameOpenFile(before, after) ||
      (options.requireSingleLink && after.nlink !== 1)
    ) {
      throw new FileChangedWhileReadingError(options.label);
    }
    return { contents, stat: after };
  } finally {
    await handle.close();
  }
};
