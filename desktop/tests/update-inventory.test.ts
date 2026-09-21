import {expect, test} from "bun:test";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile} from "node:fs/promises";
import path from "node:path";
import {collectDesktopUpdateInventory, prepareDesktopUpdateState} from "../src/update-inventory.js";
import {resolveHarnessConfig} from "../../src/config.js";
import {openHarnessPersistence, HARNESS_SQLITE_FILE} from "../../src/operations.js";
import {openCliSessionStore} from "../../src/sessions.js";
import {SqliteDatabase} from "../../src/sqlite-database.js";
import type {ManagedTask} from "../src/task-worktrees.js";
const project = (workspace: string) => ({workspace, key: `project_${createHash("sha256").update(workspace).digest("hex").slice(0, 32)}`, name: "fixture", lastOpenedAt: 1});
async function fixture(run: (f: {root: string; userData: string; source: string; task: ManagedTask}) => Promise<void>) {
 const root = await realpath(await mkdtemp("/tmp/har-update-inventory-")), userData = path.join(root, "profile"), source = path.join(root, "source"), id = randomUUID();
 await mkdir(source); await mkdir(userData, {mode: 0o700});
 const task: ManagedTask = {id, sourceWorkspace: source, sourceProjectKey: project(source).key, workspace: path.join(userData, "tasks", id, "checkout"), stateDirectory: path.join(userData, "tasks", id, "state"), status: "ready", title: "fixture", branch: "feat/fixture", baseCommit: "a".repeat(40), integrationRef: "refs/heads/main", createdAt: 1};
 await mkdir(task.workspace, {recursive: true});
 try {await run({root, userData, source, task});} finally {await rm(root, {recursive: true, force: true});}
}
test("includes unopened projects and task sources outside recents while overriding checkout state", () => fixture(async f => {
 const unopened = path.join(f.root, "unopened"); await mkdir(unopened);
 const result = await collectDesktopUpdateInventory(f.userData, [project(unopened), project(f.task.workspace)], [f.task]);
 expect(result.configs.map(c => c.workspace).sort()).toEqual([unopened, f.source, f.task.workspace].sort());
 expect(result.configs.find(c => c.workspace === f.task.workspace)!.stateDirectory).toBe(f.task.stateDirectory);
 expect(result.absentWorkspaces).toEqual([]);
}));
test("includes incomplete task states without changing their registry records or opening Git", () => fixture(async f => {
 for (const status of ["creating", "needs-attention", "removed"] as const) {
  const task = {...f.task, status}; const before = JSON.stringify(task);
  const result = await collectDesktopUpdateInventory(f.userData, [], [task]);
  expect(result.configs).toHaveLength(2); expect(JSON.stringify(task)).toBe(before);
 }
}));
test("retained history of a removed checkout blocks an incomplete backup", () => fixture(async f => {
 await rm(f.task.workspace, {recursive: true}); await mkdir(f.task.stateDirectory, {mode: 0o700});
 const bytes = path.join(f.task.stateDirectory, "history"); await writeFile(bytes, "preserve");
 await expect(collectDesktopUpdateInventory(f.userData, [], [{...f.task, status: "removed"}])).rejects.toThrow("UPDATE_STATE_WORKSPACE_UNAVAILABLE");
 expect(await readFile(bytes, "utf8")).toBe("preserve");
}));
test("records a missing checkout only when its state is also absent", () => fixture(async f => {
 await rm(f.task.workspace, {recursive: true});
 const result = await collectDesktopUpdateInventory(f.userData, [], [{...f.task, status: "removed"}]);
 expect(result.absentWorkspaces).toEqual([f.task.workspace]); expect(result.configs.map(c => c.workspace)).toEqual([f.source]);
}));
test("rejects changed identity, symlink state and duplicate tasks", () => fixture(async f => {
 await expect(collectDesktopUpdateInventory(f.userData, [{...project(f.source), key: project(f.task.workspace).key}], [])).rejects.toThrow("UPDATE_INVENTORY_INVALID");
 await expect(collectDesktopUpdateInventory(f.userData, [], [f.task, f.task])).rejects.toThrow("UPDATE_INVENTORY_INVALID");
 await symlink(f.source, f.task.stateDirectory);
 await expect(collectDesktopUpdateInventory(f.userData, [], [f.task])).rejects.toThrow("UPDATE_INVENTORY_INVALID");
}));
test("host preparation backs up the unopened source and managed task as separate complete databases", () => fixture(async f => {
 const configs = [resolveHarnessConfig({workspace: f.source, provider: "openai", storeBackend: "sqlite"}), resolveHarnessConfig({workspace: f.task.workspace, stateDirectory: f.task.stateDirectory, provider: "openai", storeBackend: "sqlite"})];
 for (const [i, config] of configs.entries()) {
  const persistence = await openHarnessPersistence(config); persistence.close();
  const sessions = await openCliSessionStore({workspace: config.workspace, stateDirectory: config.stateDirectory, scope: config.scope});
  await sessions.create({title: `retained ${i}`}); sessions.close();
 }
 const owners = configs.map(c => new SqliteDatabase(path.join(c.stateDirectory, HARNESS_SQLITE_FILE)));
 try {
  for (const db of owners) db.query("SELECT count(*) FROM sqlite_master").get();
  const prepared = await prepareDesktopUpdateState(f.userData, [project(f.task.workspace)], [f.task]);
  const receipt = JSON.parse(await readFile(path.join(f.userData, "update-recovery", prepared.transaction.id, "receipt.json"), "utf8"));
  expect(receipt.databases).toHaveLength(2);
  for (const [i, config] of configs.entries()) {
   const entry = receipt.databases.find((d: {stateDirectory: string}) => d.stateDirectory === config.stateDirectory);
   expect(entry.backup).not.toBeNull();
   const copy = new SqliteDatabase(path.join(f.userData, "update-recovery", prepared.transaction.id, entry.backup.directory, HARNESS_SQLITE_FILE));
   try {expect(copy.query<{title: string}>("SELECT title FROM zhivex_cli_sessions").get()!.title).toBe(`retained ${i}`);} finally {copy.close();}
  }
 } finally {owners.forEach(db => db.close());}
}));
