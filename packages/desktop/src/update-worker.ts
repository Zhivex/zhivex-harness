import {fstatSync, lstatSync, realpathSync} from "node:fs";
import path from "node:path";
import {adoptDesktopUpdateHandoffState, acknowledgeDesktopUpdateHandoff, assertDesktopUpdateOwnersStopped, waitForDesktopUpdateOwners, type DesktopUpdateHandoff} from "./update-handoff.js";
import {executeDesktopUpdateJob, inspectDesktopUpdateJob} from "./update-job.js";
import {desktopStateTransactionStatus, verifyDesktopStateTransaction} from "./state-transaction.js";
import {checkDesktopStateFormat} from "./state-format.js";

/** Native helper bootstrap only. fd 3 stays open until process exit. The helper
 * establishes LOCK_EX; these checks bind the inherited descriptor to its path.
 */
function checkWorkerDescriptor() {
 if (process.platform !== "darwin") throw new Error();
 const directory = process.cwd(), parent = lstatSync(directory);
 if (realpathSync(directory) !== directory || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw new Error();
 const file = lstatSync(path.join(directory, "worker.lock")), descriptor = fstatSync(3);
 for (const stat of [file, descriptor]) if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size !== 0) throw new Error();
 if (file.dev !== descriptor.dev || file.ino !== descriptor.ino) throw new Error();
}

/** Production orchestration: no renderer callbacks, fixture verifier or provider
 * access. Native signature verification remains the application's swap default.
 */
export async function runDesktopUpdateWorker(handoff: DesktopUpdateHandoff) {
 checkWorkerDescriptor();
 const access = await adoptDesktopUpdateHandoffState(handoff);
 try {
  const identity = await inspectDesktopUpdateJob(handoff.job);
  await acknowledgeDesktopUpdateHandoff(handoff, access);
  await waitForDesktopUpdateOwners(handoff, {stateAccess: access});
  return await executeDesktopUpdateJob(handoff.job, {
   assertStopped: async () => {checkWorkerDescriptor(); await assertDesktopUpdateOwnersStopped(handoff, access);},
   verifyState: async () => {
    checkWorkerDescriptor();
    if (await desktopStateTransactionStatus(handoff.job.userData, identity.state) === "active") {
     await verifyDesktopStateTransaction(handoff.job.userData, identity.state, access.entries);
    } else {
     // A lost final acknowledgement may follow reopened user work. Confirm the
     // current format only; never compare or restore historical metadata here.
     await checkDesktopStateFormat(handoff.job.userData);
    }
   },
  });
 } finally {access.close();}
}
