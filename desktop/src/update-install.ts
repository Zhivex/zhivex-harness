import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdtemp, open, realpath, rmdir} from "node:fs/promises";
import path from "node:path";
import {createApplicationSwapper, type ApplicationSwap} from "./application-swap.js";
import {createDesktopUpdateWorkerStager} from "./update-worker-staging.js";
import {prepareExclusiveDesktopUpdateState} from "./update-inventory.js";
import {armDesktopStateTransaction} from "./state-transaction.js";
import {prepareDesktopUpdateJob} from "./update-job.js";
import {prepareDesktopUpdateHandoff, waitForDesktopUpdateAcknowledgement} from "./update-handoff.js";
import {requireVerifiedUpdate, type VerifiedUpdate} from "./update-manifest.js";
import type {stageUpdateDownload} from "./update-download.js";
import type {DesktopProject} from "./bridge.js";
import type {ManagedTask} from "./task-worktrees.js";
import type {UpdateRuntime} from "./update-coordinator.js";

export type PreparedDesktopDownload = {update: VerifiedUpdate; download: Awaited<ReturnType<typeof stageUpdateDownload>>};
export class DesktopInstallError extends Error {
 constructor(readonly status: "work-active" | "install-failed" | "recovery-required") {super(status);}
}
const command = (binary: string, args: string[]) => new Promise<void>((resolve, reject) => {
 execFile(binary, args, {timeout: 60_000, maxBuffer: 64 * 1024, env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C"}}, error => error ? reject(new Error("UPDATE_IMAGE_COMMAND_FAILED")) : resolve());
});
/** Revalidate the private artifact at the point of use, without following links. */
async function verifyArtifact(prepared: PreparedDesktopDownload) {
 requireVerifiedUpdate(prepared.update);
 const {directory, artifact} = prepared.download;
 if (await realpath(directory) !== directory || artifact !== path.join(directory, "update.dmg")) throw new Error();
 const parent = await lstat(directory);
 if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw new Error();
 const file = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
 try {
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size !== prepared.update.artifact.size) throw new Error();
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let size = 0;
  while (true) {const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; size += read.bytesRead; if (size > stat.size) throw new Error(); hash.update(buffer.subarray(0, read.bytesRead));}
  const current = await lstat(artifact);
  if (current.ino !== stat.ino || current.dev !== stat.dev || size !== stat.size || hash.digest("hex") !== prepared.update.artifact.sha256) throw new Error();
 } finally {await file.close();}
}

/** Only main supplies paths/publisher policy. The readonly image is detached before
 * runtime shutdown; native verification is performed on both source and copied app. */
export async function prepareDownloadedApplication(prepared: PreparedDesktopDownload, policy: {application: string; teamId: string; version: string}, deps = {command, swapper: createApplicationSwapper()}) {
 await verifyArtifact(prepared);
 const mount = await mkdtemp(path.join(prepared.download.directory, "mount-"));
 let attached = false;
 try {
  await deps.command("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, prepared.download.artifact]); attached = true;
  await verifyArtifact(prepared);
  return await deps.swapper.prepare({application: policy.application, candidate: path.join(mount, "Zhivex Harness.app"), teamId: policy.teamId, previousVersion: policy.version, nextVersion: prepared.update.version});
 } finally {
  // A timed-out attach may still have mounted the image. Never recursively remove a mount.
  if (attached) await deps.command("/usr/bin/hdiutil", ["detach", mount]);
  else await deps.command("/usr/bin/hdiutil", ["detach", mount]).catch(() => {});
  await rmdir(mount);
 }
}

export function createDesktopUpdateInstaller(policy: {application: string; userData: string; teamId: string; version: string}, host: {
 busy(): boolean;
 block(value: boolean): void;
 hosts(): Promise<UpdateRuntime[]>;
 inventory(): {projects: DesktopProject[]; tasks: ManagedTask[]};
 closeTransports(): Promise<void>;
 clearHosts(): void;
 reload(): void;
 quit(): void;
}, services = {
 candidate: prepareDownloadedApplication,
 worker: createDesktopUpdateWorkerStager(),
 backup: prepareExclusiveDesktopUpdateState,
 arm: armDesktopStateTransaction,
 job: prepareDesktopUpdateJob,
 handoff: prepareDesktopUpdateHandoff,
 acknowledge: waitForDesktopUpdateAcknowledgement,
}) {
 let running = false, recoveryRequired = false;
 return async (prepared: PreparedDesktopDownload): Promise<void> => {
  if (recoveryRequired) throw new DesktopInstallError("recovery-required");
  if (running || host.busy()) throw new DesktopInstallError("work-active");
  running = true; host.block(true);
  const paused: UpdateRuntime[] = [];
  let closed = false, armed = false, transferred = false;
  let application: ApplicationSwap | undefined;
  let backup: Awaited<ReturnType<typeof prepareExclusiveDesktopUpdateState>> | undefined;
  try {
   requireVerifiedUpdate(prepared.update);
   const hosts = await host.hosts();
   for (const runtime of hosts) {
    paused.push(runtime);
    if (!runtime.isAlive() || await runtime.controlClose("pause")) throw new DesktopInstallError("work-active");
   }
   if (host.busy()) throw new DesktopInstallError("work-active");
   // Reject active work before doing expensive verification/copy. Nothing has
   // closed or changed persistent state at this boundary.
   application = await services.candidate(prepared, policy);
   const worker = await services.worker.prepare({...policy});
   for (const runtime of hosts) {closed = true; await runtime.close(); if (runtime.isAlive()) throw new Error();}
   await host.closeTransports(); host.clearHosts();
   const inventory = host.inventory();
   backup = await services.backup(policy.userData, inventory.projects, inventory.tasks);
   requireVerifiedUpdate(prepared.update);
   const job = await services.job(policy.userData, backup.transaction, application, {allowUnarmed: true});
   armed = true;
   await services.arm(policy.userData, backup.transaction);
   const handoff = await services.handoff(job, [], backup.access);
   const process = await services.worker.launch(worker, handoff, backup.access);
   await services.acknowledge(handoff, process.pid);
   // The worker owns the same exclusive leases before main drops them and exits.
   transferred = true; backup.releaseAccess(); host.quit();
  } catch (error) {
   if (armed) {recoveryRequired = true; throw new DesktopInstallError("recovery-required");}
   if (application) await createApplicationSwapper().discardPrepared(application).catch(() => {});
   let resumed = true;
   for (const runtime of paused) if (runtime.isAlive()) try {
    if (closed) {await runtime.close(); if (runtime.isAlive()) throw new Error();}
    else await runtime.controlClose("resume");
   } catch {resumed = false;}
   if (!resumed) {recoveryRequired = true; throw new DesktopInstallError("recovery-required");}
   if (closed) {host.clearHosts(); host.reload();}
   throw error instanceof DesktopInstallError ? error : new DesktopInstallError("install-failed");
  } finally {
   // Keep the exclusive leases on ambiguous armed failure. Restart/recovery must
   // explicitly resolve the journal before any application work can be admitted.
   if (backup && !armed && !transferred) backup.releaseAccess();
   running = false;
   if (!armed && !recoveryRequired) host.block(false);
  }
 };
}
