import {reopenCompletedDesktopUpdate} from "./update-recovery.js";
import {runDesktopUpdateWorker} from "./update-worker.js";

async function main() {
 const args = process.argv.slice(2);
 if (args.length !== 4) throw new Error();
 const [userData, id, nonce, sha256] = args as [string, string, string, string];
 const job = {userData, id};
 await runDesktopUpdateWorker({job, nonce, sha256});
 await reopenCompletedDesktopUpdate(job);
}
void main().catch(() => {
 // Paths, SQL, arguments and native verifier output never reach diagnostics.
 console.error("UPDATE_WORKER_RECOVERY_REQUIRED");
 process.exitCode = 1;
});
