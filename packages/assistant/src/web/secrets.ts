import { createHash } from 'node:crypto';

export interface SecretStore { read(): Promise<string | null | undefined>; write(value: string): Promise<void> }
/** No plaintext fallback. The OS controls access to the persisted setup and secrets. */
export function systemSecrets(directory: string): SecretStore {
  const account = createHash('sha256').update(directory).digest('hex');
  const entry = async () => {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry('ai.zhivex.assistant', account, { linux: { store: 'secret-service' } });
  };
  return {
    async read() { try { return await (await entry()).getPassword(AbortSignal.timeout(30_000)); } catch { throw new Error('SETUP_KEYCHAIN_UNAVAILABLE'); } },
    async write(value) { try { await (await entry()).setPassword(value, AbortSignal.timeout(30_000)); } catch { throw new Error('SETUP_KEYCHAIN_UNAVAILABLE'); } }
  };
}
