import { lstat } from "node:fs/promises";
import path from "node:path";

const SENSITIVE_STATE_SEGMENTS = new Set([".git", ".env", ".npmrc", "dist", "node_modules", "src"]);

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

export const validateStateDirectory = async (workspace: string, stateDirectory: string) => {
  if (stateDirectory === workspace || stateDirectory === path.parse(stateDirectory).root) {
    throw new Error("The state directory cannot be the workspace or filesystem root.");
  }

  const insideWorkspace = isInside(workspace, stateDirectory);
  const relativeSegments = insideWorkspace
    ? path.relative(workspace, stateDirectory).split(path.sep).filter(Boolean)
    : stateDirectory.slice(path.parse(stateDirectory).root.length).split(path.sep).filter(Boolean);
  const sensitiveSegment = insideWorkspace
    ? relativeSegments.find((segment) => SENSITIVE_STATE_SEGMENTS.has(segment))
    : undefined;
  if (sensitiveSegment) {
    throw new Error(`The state directory is inside the protected workspace path: ${sensitiveSegment}.`);
  }

  if (!insideWorkspace) {
    try {
      const externalEntry = await lstat(stateDirectory);
      if (externalEntry.isSymbolicLink()) {
        throw new Error(`The state directory must not be a symbolic link: ${stateDirectory}.`);
      }
      if (!externalEntry.isDirectory()) {
        throw new Error(`The state directory is not a directory: ${stateDirectory}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  let current = workspace;
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`The state directory must not resolve through a symbolic link: ${current}.`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`The state directory path contains a non-directory entry: ${current}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
};
