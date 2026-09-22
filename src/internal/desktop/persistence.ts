/** Internal, co-versioned Desktop surface; not a public package entrypoint. */
export { readRegularFileNoFollow } from "../../workspace/file-security.js";
export { statRegularFileNoFollow } from "../../workspace/file-security.js";
export { HARNESS_SQLITE_FILE } from "../../persistence/operations.js";
export { protectPersistenceSecret } from "../../persistence/persistence-secrets.js";
export { validateRecordedWorkspace } from "../../persistence/recorded-workspace.js";
export { acquireSqliteAccess } from "../../persistence/sqlite-access.js";
export { adoptExclusiveSqliteAccess } from "../../persistence/sqlite-access.js";
export { exclusiveSqliteAccessDescriptor } from "../../persistence/sqlite-access.js";
export type { SqliteAccessLease } from "../../persistence/sqlite-access.js";
export { SqliteDatabase } from "../../persistence/sqlite-database.js";
export { createArchivedHarnessStateBackup } from "../../persistence/state-backup.js";
export { createHarnessStateBackup } from "../../persistence/state-backup.js";
export { validateStateDirectory } from "../../persistence/state-directory.js";
