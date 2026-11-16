import { applicationMigration } from '../packages/core/src/application/offline-migration.js';
// Explicit roots only. Never discover user profiles or access a credential store.
const [action, backup, ...args] = process.argv.slice(2);
const confirmation = args.find(a => a.startsWith('--expected-current='))?.slice('--expected-current='.length);
const roots = args.filter(a => !a.startsWith('--'));
if (!['backup', 'inspect', 'abort', 'inspect-rollback', 'rollback'].includes(action ?? '') || !backup || !roots.length || args.some(a => a.startsWith('--') && !a.startsWith('--expected-current='))) {
  console.error('Usage: bun run migration:application <backup|inspect|abort|inspect-rollback|rollback> <backup-directory> <state-root>... [--expected-current=SHA256]');
  process.exit(2);
}
try {
  const result = await applicationMigration({ action: action as 'backup' | 'inspect' | 'abort' | 'inspect-rollback' | 'rollback', backup, roots, ...(confirmation ? {expectedCurrentSha256: confirmation} : {}) });
  console.log(JSON.stringify(result));
} catch (error) {
  // Paths, persisted content and native error text never go into logs.
  const code = error instanceof Error && /^MIGRATION_[A-Z_]+$/.test(error.message) ? error.message : 'MIGRATION_FAILED';
  console.error(JSON.stringify({code, recovery: 'Keep all writers stopped. Retry with the same backup and roots; do not delete recovery markers.'}));
  process.exitCode = 1;
}
