import { lstat } from 'node:fs/promises';
import path from 'node:path';

export const MIGRATION_MARKER = '.zhivex-migration.json';
/** A surviving intent blocks startup even after the migrating process dies. */
export async function assertNoApplicationMigration(directory: string): Promise<void> {
  let current = path.resolve(directory);
  for (;;) {
    try { await lstat(path.join(current, MIGRATION_MARKER)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current); if (parent === current) return;
      current = parent; continue;
    }
    throw new Error('APPLICATION_MIGRATION_RECOVERY_REQUIRED');
  }
}
