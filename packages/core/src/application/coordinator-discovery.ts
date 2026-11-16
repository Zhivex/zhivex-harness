import { spawn } from 'node:child_process';
import { connectCoordinator } from './coordinator-client.js';

const unavailable = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && error.message === 'LOCAL_SERVICE_UNAVAILABLE');
/** Launch a persistent service only when discovery finds no live endpoint; the manager lease resolves races. */
export async function ensureApplicationCoordinator(directory: string, launcher: {executable: string; entry: string}) {
  try {return await connectCoordinator(directory);} catch (error) {if (!unavailable(error)) throw error;}
  const child = spawn(launcher.executable, [launcher.entry, '--application-directory', directory], {detached: true, stdio: 'ignore', env: process.env});
  let failed = false;
  child.once('error', () => {failed = true;}); child.unref();
  for (let attempt = 0; attempt < 300; attempt++) {
    try {return await connectCoordinator(directory);} catch (error) {if (!unavailable(error)) throw error;}
    if (failed) throw new Error('COORDINATOR_LAUNCH_FAILED');
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error('COORDINATOR_LAUNCH_FAILED');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Do not kill a process that may already serve another client. Its lease prevents duplicate owners.
  throw new Error('COORDINATOR_START_UNCONFIRMED');
}
