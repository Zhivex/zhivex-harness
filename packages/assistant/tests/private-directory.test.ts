import { test, expect } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncPrivateDirectory } from '../src/private-directory.js';

test('directory sync rejects replacement directories, symlinks, files and public permissions', async () => {
  const root = await mkdtemp('/tmp/assistant-directory-');
  const directory = root + '/state';
  try {
    await mkdir(directory, { mode: 0o700 });
    const original = await lstat(directory);
    await syncPrivateDirectory(directory, 'UNSAFE', original);
    await rename(directory, root + '/original');
    await symlink(root + '/original', directory);
    await expect(syncPrivateDirectory(directory, 'UNSAFE', original)).rejects.toThrow();
    await rm(directory);
    await mkdir(directory, { mode: 0o700 });
    await expect(syncPrivateDirectory(directory, 'UNSAFE', original)).rejects.toThrow('UNSAFE');
    await chmod(directory, 0o755);
    await expect(syncPrivateDirectory(directory, 'UNSAFE')).rejects.toThrow('UNSAFE');
    await rm(directory, { recursive: true });
    await writeFile(directory, 'not a directory', { mode: 0o600 });
    await expect(syncPrivateDirectory(directory, 'UNSAFE')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
