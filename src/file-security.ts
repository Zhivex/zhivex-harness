import { constants as fsConstants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

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
    return await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw invalidFileError(label);
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
