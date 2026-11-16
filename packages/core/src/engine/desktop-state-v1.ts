/** Versioned, host-only Desktop update/recovery contract. No renderer or SQL API. */
export {
  DESKTOP_DATABASE_BACKUP_LIMIT as HOST_DATABASE_SNAPSHOT_LIMIT,
  createDesktopDatabaseBackup as createHostDatabaseSnapshot,
  verifyDesktopDatabaseBackup as verifyHostDatabaseSnapshot,
  verifyDesktopDatabaseState as verifyHostDatabaseState
} from "../persistence/host-database-backup.js";
export type {
  DesktopDatabaseBackup as HostDatabaseSnapshot,
  DesktopBackupConfig as HostDatabaseSnapshotConfig
} from "../persistence/host-database-backup.js";
export { HARNESS_SQLITE_FILE } from "../persistence/operations.js";
export { validateStateDirectory } from "../persistence/state-directory.js";
export { validateRecordedWorkspace } from "../persistence/recorded-workspace.js";
export {
  acquireSqliteAccess,
  adoptExclusiveSqliteAccess,
  exclusiveSqliteAccessDescriptor
} from "../persistence/sqlite-access.js";
export type { SqliteAccessLease } from "../persistence/sqlite-access.js";
export { protectPersistenceSecret } from "../persistence/persistence-secrets.js";
export { readRegularFileNoFollow, statRegularFileNoFollow } from "../workspace/file-security.js";
