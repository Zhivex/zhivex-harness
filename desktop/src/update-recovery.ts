import {execFile} from "node:child_process";
import {acquireSqliteAccess, type SqliteAccessLease} from "../../src/sqlite-access.js";
import {createApplicationSwapper} from "./application-swap.js";
import {findDesktopUpdateRecoveryJob, inspectDesktopUpdateJob, type DesktopUpdateJob} from "./update-job.js";
import {prepareDesktopUpdateHandoff, waitForDesktopUpdateAcknowledgement} from "./update-handoff.js";
import {createDesktopUpdateWorkerStager} from "./update-worker-staging.js";

/** Runs before opening registries. Resumes the exact journal pinned by active.json;
 * no backup, restore or application mutation occurs in this main process. */
export async function resumeDesktopUpdateRecovery(policy: {userData: string; application: string; teamId: string; version: string}) {
 const job = await findDesktopUpdateRecoveryJob(policy.userData), identity = await inspectDesktopUpdateJob(job);
 if (identity.application.application !== policy.application) throw new Error("UPDATE_RECOVERY_APPLICATION_MISMATCH");
 const stager = createDesktopUpdateWorkerStager(), worker = await stager.prepare(policy);
 const access: Array<{databasePath: string; lease: SqliteAccessLease}> = [];
 try {
  for (const databasePath of identity.databasePaths) {
   const lease = acquireSqliteAccess(databasePath, true); if (!lease) throw new Error();
   access.push({databasePath, lease});
  }
  const handoff = await prepareDesktopUpdateHandoff(job, [], access);
  const child = await stager.launch(worker, handoff, access);
  await waitForDesktopUpdateAcknowledgement(handoff, child.pid);
 } finally {for (const entry of access) entry.lease.close();}
}

/** Worker-only. Leases must be released first. Launch Services gets a verified
 * application path, never a command, URL, manifest argument or renderer input. */
export async function reopenCompletedDesktopUpdate(job: DesktopUpdateJob) {
 const identity = await inspectDesktopUpdateJob(job);
 if (identity.phase !== "completed" || !identity.outcome) throw new Error("UPDATE_RESTART_NOT_READY");
 await createApplicationSwapper().verifyOutcome(identity.application, identity.outcome);
 await new Promise<void>((resolve, reject) => {
  execFile("/usr/bin/open", ["-n", "-a", identity.application.application], {timeout: 30_000, maxBuffer: 16 * 1024, env: {PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C"}}, error => error ? reject(new Error("UPDATE_RESTART_FAILED")) : resolve());
 });
}
