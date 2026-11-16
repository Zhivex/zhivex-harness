import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {z} from 'zod';
import type {SecretStore} from './assistant/managed/secrets.js';

const requestSchema = z.discriminatedUnion('operation', [
  z.object({operation: z.literal('read'), account: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({operation: z.literal('write'), account: z.string().regex(/^[a-f0-9]{64}$/), value: z.string().max(2 * 1024 * 1024)}).strict(),
]);
const responseSchema = z.object({ok: z.literal(true), value: z.string().nullable().optional()}).strict();
/** One killable process per native request. Secrets travel only through private pipes.
 * A write with no confirmed response locks writes until an explicit successful read.
 */
export async function createProcessSecretStore(directory: string, options: {executable: string; entry: string; args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number}): Promise<SecretStore> {
  const account = createHash('sha256').update(await realpath(directory)).digest('hex');
  const timeoutMs = options.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('SETUP_KEYCHAIN_TIMEOUT_INVALID');
  let busy = false, uncertain = false;
  const invoke = async (input: z.infer<typeof requestSchema>) => {
    if (busy) throw new Error('SETUP_KEYCHAIN_BUSY');
    if (input.operation === 'write' && uncertain) throw new Error('SETUP_KEYCHAIN_RECONCILE_REQUIRED');
    busy = true;
    try {
      const response = await new Promise<z.infer<typeof responseSchema>>((resolve, reject) => {
        const child = spawn(options.executable, [options.entry, ...(options.args ?? [])], {stdio: ['pipe', 'pipe', 'ignore'], env: options.env ?? process.env});
        const output: Buffer[] = []; let bytes = 0, failed = false;
        const timer = setTimeout(() => {failed = true; child.kill('SIGKILL');}, timeoutMs);
        child.once('error', () => {failed = true;});
        child.stdin.on('error', () => {failed = true;});
        child.stdout.on('error', () => {failed = true; child.kill('SIGKILL');});
        child.stdout.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 3 * 1024 * 1024) {failed = true; child.kill('SIGKILL');} else output.push(Buffer.from(chunk));
        });
        // Wait for process exit before admitting another read or write, including after timeout.
        child.once('close', code => {
          clearTimeout(timer);
          if (failed || code !== 0) {reject(new Error('SETUP_KEYCHAIN_UNAVAILABLE')); return;}
          try {resolve(responseSchema.parse(JSON.parse(Buffer.concat(output).toString('utf8'))));} catch {reject(new Error('SETUP_KEYCHAIN_UNAVAILABLE'));}
        });
        child.stdin.end(JSON.stringify(input));
      });
      return response;
    } catch {
      if (input.operation === 'write') uncertain = true;
      throw new Error(input.operation === 'write' ? 'SETUP_KEYCHAIN_WRITE_UNCONFIRMED' : 'SETUP_KEYCHAIN_UNAVAILABLE');
    } finally {busy = false;}
  };
  return {
    async read() {const response = await invoke({operation: 'read', account}); if (!('value' in response)) throw new Error('SETUP_KEYCHAIN_UNAVAILABLE'); uncertain = false; return response.value;},
    async write(value) {await invoke(requestSchema.parse({operation: 'write', account, value}));},
  };
}

/** Internal worker entrypoint. Never logs native errors or credential values. */
export async function runCredentialWorker(createStore: (account: string) => Promise<SecretStore>) {
  // Bound orphan lifetime if the parent crashes during a native request.
  const watchdog = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 12000);
  watchdog.unref();
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {size += chunk.length; if (size > 3 * 1024 * 1024) throw new Error('LIMIT'); chunks.push(Buffer.from(chunk));}
    const request = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const entry = await createStore(request.account);
    if (request.operation === 'read') process.stdout.write(JSON.stringify({ok: true, value: (await entry.read()) ?? null}));
    else {await entry.write(request.value); process.stdout.write('{"ok":true}');}
  } catch {process.exitCode = 1;} finally {clearTimeout(watchdog);}
}
