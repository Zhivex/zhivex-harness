import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { readRegularFileNoFollow } from '../workspace/file-security.js';
import { createHarnessToolPolicy } from './tool-policy.js';

/** Explicit host input only. Never discover this file from repository instructions. */
export const loadHarnessToolPolicyFile = async (filename: string, workspaceRoot: string) => {
  if (!path.isAbsolute(filename)) throw new Error('Tool policy requires an absolute operator-selected path.');
  let root = await realpath(workspaceRoot);
  // A workspace may be a subdirectory of a repository. Its siblings remain
  // repository-controlled inputs, not host configuration.
  for (let directory = root; ; directory = path.dirname(directory)) {
    try { await lstat(path.join(directory, '.git')); root = directory; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(directory) === directory) break;
  }
  const absolute = path.resolve(filename);
  // Match the safe reader's OS-owned Darwin aliases without resolving user links.
  const target = process.platform === 'darwin' ? absolute.replace(/^\/(tmp|var|etc)(\/|$)/, '/private/$1$2') : absolute;
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Tool policy must be outside the workspace authority.');
  }
  const { contents, stat } = await readRegularFileNoFollow(target, {
    label: 'Tool policy', maxBytes: 128 * 1024, requireSingleLink: true
  });
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error('Tool policy must be owned by the current user with private permissions.');
  }
  // The descriptor-bound read rejects symlink ancestors and concurrent byte changes.
  // Validate before returning any input to runtime construction.
  const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
  return createHarnessToolPolicy(input as Parameters<typeof createHarnessToolPolicy>[0]);
};
