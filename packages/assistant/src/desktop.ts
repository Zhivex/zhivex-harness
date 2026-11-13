import { verifyPilotManifest } from './pilot/manifest.js';
import { createDesktopLifecycle, type DesktopLifecycle } from './desktop-lifecycle.js';
/** Private stdio bridge owned by the native shell; never write the ready URL to logs. */
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManagedAssistant } from './web/setup.js';
import { nativeProjectSelection } from './native-selection.js';

let stopping = false;
let lifecycle: DesktopLifecycle | undefined;
let app: Awaited<ReturnType<typeof startManagedAssistant>> | undefined;
async function stop() {
  if (stopping) return;
  stopping = true;
  lifecycle?.stop();
  const forced = setTimeout(() => process.exit(1), 10000); forced.unref();
  await app?.controlClose('pause').catch(() => {}); await app?.controlClose('cancel').catch(() => {});
  await app?.close();
  process.exit(0);
}
process.stdin.resume();
const selection = nativeProjectSelection(process.stdin, process.stdout, () => void stop(), () => lifecycle?.requestQuit());
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
try {
  if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('PILOT_PLATFORM_UNSUPPORTED');
  const integrity=await verifyPilotManifest(fileURLToPath(new URL('../',import.meta.url))).catch(()=>{throw new Error('PILOT_INTEGRITY_FAILED');});
  if(integrity.integrity!=='matched'||!integrity.platformMatches)throw new Error('PILOT_INTEGRITY_FAILED');
  const directory = process.env.ASSISTANT_DESKTOP_DIRECTORY ?? path.join(homedir(), '.zhx-app');
  lifecycle = await createDesktopLifecycle({ directory, native: selection, control: async operation => await app?.controlClose(operation) ?? false, work: async () => await app?.work() ?? [], close: async () => { await app?.close(); process.exit(0); } });
  app = await startManagedAssistant(process.env.ASSISTANT_DESKTOP_DIRECTORY ?? path.join(homedir(), '.zhx-app'), {
    assetsDirectory: fileURLToPath(new URL('../web/dist', import.meta.url)),
    onStop: () => lifecycle?.requestQuit(),
    native: selection, lifecycle,
    coding: { execution: 'local', configurationId: 'assistant-native-local-v1' },
    ...(process.platform === 'darwin' ? { chooseProject: selection.choose } : {}),
  });
  if (stopping) { await app.close(); process.exit(0); }
  process.stdout.write(JSON.stringify({ url: app.url }) + '\n');
} catch (error) {
  // No credentials, paths or provider responses in native crash diagnostics.
  const message=error instanceof Error&&error.message==='PILOT_PLATFORM_UNSUPPORTED'?'This native pilot supports macOS Apple Silicon only.':error instanceof Error&&error.message.startsWith('PILOT_')?'Pilot bundle integrity could not be verified. Reinstall the complete bundle; do not mix runtime versions.':'Assistant could not start. Close other Assistant instances and retry.';
  process.stderr.write(message+'\n');
  process.exit(1);
}
