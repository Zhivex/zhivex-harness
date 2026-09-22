import {createHash} from "node:crypto";
import {lstat, realpath, mkdir} from "node:fs/promises";
import path from "node:path";
import {resolveHarnessConfig} from "../../src/config.js";
import type {DesktopBackupConfig} from "./database-backup.js";
import {validateStateDirectory} from "../../src/state-directory.js";
import type {DesktopProject} from "./bridge.js";
import type {ManagedTask} from "./task-worktrees.js";
import {prepareDesktopStateTransaction} from "./state-transaction.js";
import {acquireSqliteAccess, type SqliteAccessLease} from "../../src/sqlite-access.js";
import {HARNESS_SQLITE_FILE} from "../../src/operations.js";

export class UpdateInventoryError extends Error {
 constructor(readonly code: "UPDATE_INVENTORY_INVALID" | "UPDATE_STATE_WORKSPACE_UNAVAILABLE") {super(code);}
}
const identity = (workspace: string) => `project_${createHash("sha256").update(workspace).digest("hex").slice(0, 32)}`;
function absolute(value: string) {if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error();}
async function exists(filename: string) {try {await lstat(filename); return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e;}}
async function canonicalOrAbsent(filename: string) {
 let ancestor = filename;
 while (!await exists(ancestor)) {const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error(); ancestor = parent;}
 if (await realpath(ancestor) !== ancestor || !(await lstat(ancestor)).isDirectory()) throw new Error();
 return ancestor === filename;
}

/** Host snapshots from registry.list() and tasks.list(), with mutation admission
 * already closed. Include unopened projects, every task status, and source projects
 * evicted from the recent-project list. Never use the open-runtime map as inventory.
 * This reads paths/configuration only; it neither opens registries nor reconciles Git.
 */
export async function collectDesktopUpdateInventory(userData: string, projects: DesktopProject[], tasks: ManagedTask[]): Promise<{
 configs: DesktopBackupConfig[];
 absentWorkspaces: string[];
}> {
 try {
  projects = structuredClone(projects); tasks = structuredClone(tasks);
  absolute(userData); if (await realpath(userData) !== userData || projects.length > 100 || tasks.length > 500) throw new Error();
  if (new Set(projects.map(p => p.key)).size !== projects.length || new Set(tasks.map(t => t.id)).size !== tasks.length || new Set(tasks.map(t => t.workspace)).size !== tasks.length) throw new Error();
  const sources = new Map<string, string>(), taskStates = new Map<string, string>();
  for (const task of tasks) {
   if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(task.id) ||
       !["creating", "ready", "needs-attention", "removed"].includes(task.status)) throw new Error();
   absolute(task.sourceWorkspace);
   if (task.sourceProjectKey !== identity(task.sourceWorkspace) || task.workspace !== path.join(userData, "tasks", task.id, "checkout") || task.stateDirectory !== path.join(userData, "tasks", task.id, "state")) throw new Error();
   taskStates.set(task.workspace, task.stateDirectory);
   sources.set(task.sourceWorkspace, path.join(task.sourceWorkspace, ".zhivex-harness/runs"));
  }
  for (const project of projects) {
   absolute(project.workspace); if (project.key !== identity(project.workspace)) throw new Error();
   sources.set(project.workspace, path.join(project.workspace, ".zhivex-harness/runs"));
  }
  // A task checkout can also be a recent project or another task's source.
  // Its managed state directory always wins over the ordinary project default.
  for (const [workspace, stateDirectory] of taskStates) sources.set(workspace, stateDirectory);
  if (sources.size > 600) throw new Error();
  const configs: DesktopBackupConfig[] = [], absentWorkspaces: string[] = [];
  for (const [workspace, stateDirectory] of sources) {
   const workspacePresent = await canonicalOrAbsent(workspace);
   const statePresent = await canonicalOrAbsent(stateDirectory);
   await validateStateDirectory(workspace, stateDirectory);
   if (!workspacePresent) {
    if (statePresent) {
     // Only managed task state has a trusted retained identity independent of a
     // missing checkout; unavailable ordinary projects must not be rebound.
     if (!taskStates.has(workspace)) throw new UpdateInventoryError("UPDATE_STATE_WORKSPACE_UNAVAILABLE");
     configs.push({...resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"}), workspaceAbsent: true});
    } else absentWorkspaces.push(workspace);
    continue;
   }
   configs.push(resolveHarnessConfig({workspace, stateDirectory, storeBackend: "sqlite", provider: "openai"}));
  }
  return {configs, absentWorkspaces};
 } catch (e) {
  if (e instanceof UpdateInventoryError) throw e;
  throw new UpdateInventoryError("UPDATE_INVENTORY_INVALID");
 }
}

/** Host preparation adapter. Admission must remain closed until the caller either
 * arms this transaction or abandons the update and explicitly resumes runtimes.
 */
export async function prepareDesktopUpdateState(userData: string, projects: DesktopProject[], tasks: ManagedTask[]) {
 const inventory = await collectDesktopUpdateInventory(userData, projects, tasks);
 const transaction = await prepareDesktopStateTransaction(userData, inventory.configs);
 return {transaction, inventory};
}

/** After pausing and closing known runtimes, before backup. Acquires every state
 * lease nonblockingly or releases all acquired leases. Keep returned leases until
 * the native worker acknowledges their inheritance; never unlink the lock files.
 */
export async function prepareExclusiveDesktopUpdateState(userData: string, projects: DesktopProject[], tasks: ManagedTask[]) {
 const access: Array<{databasePath: string; lease: SqliteAccessLease}> = [];
 const releaseAccess = () => {let failed = false; for (const entry of access) {try {entry.lease.close();} catch {failed = true;}} if (failed) throw new Error("UPDATE_STATE_ACCESS_RELEASE_FAILED");};
 try {
  if (process.platform !== "darwin") throw new Error();
  const inventory = await collectDesktopUpdateInventory(userData, projects, tasks);
  const configs: DesktopBackupConfig[] = [];
  for (const config of [...inventory.configs].sort((a, b) => a.stateDirectory.localeCompare(b.stateDirectory))) {
   await validateStateDirectory(config.workspace, config.stateDirectory);
   await mkdir(config.stateDirectory, {recursive: true, mode: 0o700});
   const info = await lstat(config.stateDirectory);
   if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error();
   const databasePath = path.join(await realpath(config.stateDirectory), HARNESS_SQLITE_FILE), lease = acquireSqliteAccess(databasePath, true);
   if (!lease) throw new Error(); access.push({databasePath, lease}); configs.push({...config, accessLease: lease});
  }
  const transaction = await prepareDesktopStateTransaction(userData, configs);
  return {transaction, inventory, access, releaseAccess};
 } catch {releaseAccess(); throw new Error("UPDATE_STATE_ACCESS_PREPARATION_FAILED");}
}
