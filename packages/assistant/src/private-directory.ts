import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';

/** Validate and sync the opened directory, never a separately checked path. */
export async function syncPrivateDirectory(directory: string, errorCode: string, expected?: Pick<Stats, 'dev' | 'ino'>) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
        (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) {
      throw new Error(errorCode);
    }
    await handle.sync();
  } finally { await handle.close(); }
}
