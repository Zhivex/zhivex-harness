/** Private stdio bridge owned by the native shell; never write the ready URL to logs. */
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManagedAssistant } from './web/setup.js';

let stopping = false;
let app: Awaited<ReturnType<typeof startManagedAssistant>> | undefined;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app?.close();
  process.exit(0);
}
process.stdin.resume();
process.stdin.once('end', () => void stop());
process.stdin.once('data', () => void stop());
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
try {
  app = await startManagedAssistant(process.env.ASSISTANT_DESKTOP_DIRECTORY ?? path.join(homedir(), '.zhx-app'), {
    assetsDirectory: fileURLToPath(new URL('../web/dist', import.meta.url)),
    onStop: () => void stop(),
  });
  if (stopping) { await app.close(); process.exit(0); }
  process.stdout.write(JSON.stringify({ url: app.url }) + '\n');
} catch {
  // No credentials, paths or provider responses in native crash diagnostics.
  process.stderr.write('Assistant could not start. Close other Assistant instances and retry.\n');
  process.exit(1);
}
