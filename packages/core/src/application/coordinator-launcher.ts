import {createProcessSecretStore} from './credential-process.js';
import { mkdir, realpath } from 'node:fs/promises';
import { acquireApplicationCoordinator } from './coordinator.js';

/** Node launcher adapter; the core receives secrets through the same injected interface as Electron. */
export async function launchApplicationCoordinator(directory: string) {
  await mkdir(directory, {recursive: true, mode: 0o700}); directory = await realpath(directory);
  const secrets = await createProcessSecretStore(directory, {executable: process.execPath, entry: await realpath(process.argv[1]!), args: ['--credential-worker']});
  const application = await acquireApplicationCoordinator(directory, {secrets});
  process.stdout.write(JSON.stringify({schemaVersion: 1, kind: 'application-ready', directory, owned: application.ownsService}) + '\n');
  if (application.ownsService) {
    const stop = () => {void application.close().catch(() => {process.stderr.write('{"kind":"application-error","code":"APPLICATION_SHUTDOWN_FAILED"}\n'); process.exitCode = 1;});};
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }
}
