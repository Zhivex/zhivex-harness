export interface SecretStore { read(): Promise<string | null | undefined>; write(value: string): Promise<void> }

/** A native credential read may ignore cancellation. Bound admission without treating
 * an inaccessible store as empty, replaying reads or allowing a concurrent write.
 * A timeout does not cancel the native call: its late result is deliberately discarded.
 * Writes are not timed out here because an unconfirmed write needs reconciliation.
 */
export function withBoundedSecretReads(store: SecretStore, timeoutMs = 10_000): SecretStore {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('SETUP_KEYCHAIN_TIMEOUT_INVALID');
  let pending = false;
  return {
    async read() {
      if (pending) throw new Error('SETUP_KEYCHAIN_BUSY');
      pending = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = Promise.resolve().then(() => store.read()).finally(() => {pending = false;});
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('SETUP_KEYCHAIN_UNAVAILABLE')), timeoutMs);
        })]);
      } finally {if (timer) clearTimeout(timer);}
    },
    async write(value) {
      if (pending) throw new Error('SETUP_KEYCHAIN_BUSY');
      await store.write(value);
    },
  };
}
