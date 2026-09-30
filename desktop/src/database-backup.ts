/** Desktop naming aliases for the versioned host state contract. */
export { HOST_DATABASE_SNAPSHOT_LIMIT as DESKTOP_DATABASE_BACKUP_LIMIT, createHostDatabaseSnapshot as createDesktopDatabaseBackup, verifyHostDatabaseSnapshot as verifyDesktopDatabaseBackup, verifyHostDatabaseState as verifyDesktopDatabaseState } from "@zhivex-ai/harness/desktop/v1/state";
export type { HostDatabaseSnapshot as DesktopDatabaseBackup, HostDatabaseSnapshotConfig as DesktopBackupConfig } from "@zhivex-ai/harness/desktop/v1/state";
