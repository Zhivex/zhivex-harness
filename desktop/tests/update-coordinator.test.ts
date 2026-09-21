import {expect, test} from "bun:test";
import {createUpdateCoordinator, type UpdateRuntime} from "../src/update-coordinator.js";
function fixture() {
 const calls: string[] = []; let active = false, alive = true;
 const host: UpdateRuntime = {
  isAlive: () => alive,
  async controlClose(op) {calls.push(op); return op === "pause" && active;},
  async close() {calls.push("close"); alive = false;},
 };
 const deps = {
  busy: () => false,
  hosts: async () => [host],
  async backup() {calls.push("backup"); return {id: "fixture"};},
  async markRecovery(_backup: {id: string}) {calls.push("mark");},
  async install(_backup: {id: string}) {calls.push("install");},
  async recover(_backup: {id: string}) {calls.push("recover");},
  async clearRecovery() {calls.push("clear");},
  clearClosedHosts() {calls.push("forget");},
 };
 return {calls, deps, host, active: () => {active = true;}};
}
test("successful update backs up before closing, leaves old process blocked until restart", async () => {
 const f = fixture(), c = createUpdateCoordinator(f.deps);
 await c.apply();
 expect(f.calls).toEqual(["pause", "backup", "mark", "close", "forget", "install", "clear"]);
 expect(c.phase).toBe("restart-required"); expect(c.blocked).toBe(true);
 await expect(c.apply()).rejects.toThrow("UPDATE_WORK_ACTIVE");
});
test("in-flight work refuses the update and resumes without cancelling or closing", async () => {
 const f = fixture(); f.active(); const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_WORK_ACTIVE");
 expect(f.calls).toEqual(["pause", "resume"]); expect(c.blocked).toBe(false);
});
test("global critical work refuses even before enumerating runtimes", async () => {
 const f = fixture(); f.deps.busy = () => true; const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_WORK_ACTIVE"); expect(f.calls).toEqual([]); expect(c.blocked).toBe(false);
});
test("backup refusal for durable pending work resumes without installation", async () => {
 const f = fixture(); f.deps.backup = async () => {f.calls.push("backup"); throw new Error("private pending approval path");};
 const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_PREPARATION_FAILED");
 expect(f.calls).toEqual(["pause", "backup", "resume"]); expect(c.phase).toBe("idle");
});
test("global operation admitted during backup is detected before any runtime close", async () => {
 const f = fixture(); f.deps.backup = async () => {f.calls.push("backup"); f.deps.busy = () => true; return {id: "fixture"};};
 const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_WORK_ACTIVE");
 expect(f.calls).toEqual(["pause", "backup", "mark", "clear", "resume"]); expect(c.blocked).toBe(false);
});
test("failed installation restores before clearing journal, then requires restart", async () => {
 const f = fixture(); f.deps.install = async () => {f.calls.push("install"); throw new Error("private installation details");};
 const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_INSTALL_FAILED");
 expect(f.calls).toEqual(["pause", "backup", "mark", "close", "forget", "install", "forget", "recover", "clear"]);
 expect(c.phase).toBe("restart-required"); expect(c.blocked).toBe(true);
});
test("unconfirmed rollback keeps recovery marker and admission blocked", async () => {
 const f = fixture(); f.deps.install = async () => {throw new Error();}; f.deps.recover = async () => {f.calls.push("recover"); throw new Error();};
 const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_RECOVERY_REQUIRED");
 expect(f.calls).not.toContain("clear"); expect(c.phase).toBe("recovery-required"); expect(c.blocked).toBe(true);
});
test("lost marker acknowledgement cleans the marker before resuming; cleanup failure blocks", async () => {
 for (const cleanupFails of [false, true]) {
  const f = fixture(); f.deps.markRecovery = async () => {f.calls.push("mark"); throw new Error();};
  f.deps.clearRecovery = async () => {f.calls.push("clear"); if (cleanupFails) throw new Error();};
  const c = createUpdateCoordinator(f.deps);
  await expect(c.apply()).rejects.toThrow(cleanupFails ? "UPDATE_RECOVERY_REQUIRED" : "UPDATE_PREPARATION_FAILED");
  expect(f.calls).toEqual(["pause", "backup", "mark", "clear", "resume"]);
  expect(c.blocked).toBe(cleanupFails);
 }
});
test("unknown pause/resume state never permits an update", async () => {
 const f = fixture(); f.host.controlClose = async op => {f.calls.push(op); throw new Error();};
 const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_RECOVERY_REQUIRED"); expect(f.calls).toEqual(["pause", "resume"]); expect(c.blocked).toBe(true);
});
test("admission closes synchronously and concurrent update attempts cannot overlap", async () => {
 const f = fixture(); let release!: () => void;
 f.deps.hosts = async () => {await new Promise<void>(resolve => {release = resolve;}); return [f.host];};
 const c = createUpdateCoordinator(f.deps), first = c.apply();
 expect(c.phase).toBe("preparing"); expect(c.blocked).toBe(true);
 await expect(c.apply()).rejects.toThrow("UPDATE_WORK_ACTIVE");
 release(); await first; expect(f.calls.filter(c => c === "install")).toHaveLength(1);
});
test("partial runtime shutdown cannot reopen the old app or install over unknown live owners", async () => {
 const f = fixture(); f.host.close = async () => {f.calls.push("close"); throw new Error();};
 const c = createUpdateCoordinator(f.deps);
 await expect(c.apply()).rejects.toThrow("UPDATE_RECOVERY_REQUIRED");
 expect(f.calls).toEqual(["pause", "backup", "mark", "close", "close"]);
 expect(c.phase).toBe("recovery-required");
});
