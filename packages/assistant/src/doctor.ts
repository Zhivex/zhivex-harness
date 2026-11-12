import { parseAssistantProvider, type AssistantProviderConfig } from './providers/provider.js';
import { parseCompatibleProvider, type CompatibleProviderConfig } from './providers/openai-compatible.js';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { providerAvailability } from '@zhivex-ai/harness/engine';

/** Offline configuration check. Never reads credentials/state contents, writes files, or calls providers. */
export async function assistantDoctor(input: { directory: string; ownerId: string; calendar: boolean; telegramOwner?: string; provider?: string; compatibleProvider?: CompatibleProviderConfig; assistantProvider?: AssistantProviderConfig }, env: NodeJS.ProcessEnv = process.env) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  check('owner', /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.ownerId), 'Use a stable local owner identifier.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  check('runtime', major! > 22 || (major === 22 && minor! >= 13), 'Built host requires Node >=22.13.0.');
  const directory = path.resolve(input.directory);
  let cursor = directory;
  while (true) {
    try {
      const stat = await lstat(cursor);
      check('directory', stat.isDirectory() && !stat.isSymbolicLink() && (cursor !== directory || (stat.uid === process.getuid?.() && !(stat.mode & 0o077))),
        cursor === directory ? 'Existing runtime directory must be private and owned by this user.' : 'Runtime directory will be created on first connection/start.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(cursor) === cursor) { check('directory', false, 'Cannot inspect runtime directory.'); break; }
      cursor = path.dirname(cursor);
    }
  }
  if (input.calendar) {
    check('google-client', (env.ASSISTANT_GOOGLE_CLIENT_ID ?? '').endsWith('.apps.googleusercontent.com'), 'Set ASSISTANT_GOOGLE_CLIENT_ID for a Desktop OAuth client.');
    const value = env.ASSISTANT_CREDENTIAL_KEY ?? '', key = Buffer.from(value, 'base64');
    check('credential-key', key.length === 32 && key.toString('base64') === value, 'Set a persistent external 32-byte base64 ASSISTANT_CREDENTIAL_KEY.'); key.fill(0);
  }
  if (input.telegramOwner !== undefined) {
    check('telegram-owner', /^[1-9][0-9]{0,15}$/.test(input.telegramOwner) && Number.isSafeInteger(Number(input.telegramOwner)), 'Use your numeric private Telegram user ID.');
    check('telegram-token', /^\d+:[A-Za-z0-9_-]{20,}$/.test(env.ASSISTANT_TELEGRAM_BOT_TOKEN ?? ''), 'Set ASSISTANT_TELEGRAM_BOT_TOKEN.');
  }
  if (input.compatibleProvider) {
    try { const config = parseCompatibleProvider(input.compatibleProvider);
      check('compatible-provider', true, 'Protocol and declared capabilities configured; not live-certified.');
      check('compatible-credential', Boolean(env[config.apiKeyEnv]?.trim()), 'Set the configured API key environment variable.');
    } catch { check('compatible-provider', false, 'Invalid compatible-provider configuration.'); }
  }
  if (input.assistantProvider) {
    try { const config = parseAssistantProvider(input.assistantProvider);
      check('provider', !input.provider && !input.compatibleProvider, 'Choose one provider configuration.');
      check('provider-configuration', Boolean(env[config.apiKeyEnv]?.trim()), 'Set the configured API key environment variable. Presence does not verify remote access.');
    } catch { check('provider', false, 'Invalid provider configuration.'); }
  } else if (input.compatibleProvider) {
    check('provider', !input.provider, 'A compatible provider cannot be combined with --provider.');
  } else {
    const provider = providerAvailability(env).find(item => item.id === input.provider?.trim().toLowerCase());
    check('provider', Boolean(provider), 'Choose a supported --provider or configure an OpenAI-compatible provider.');
    if (provider) check('provider-configuration', provider.configured,
      'Configure the provider credentials and required environment using its guide. Presence does not verify remote access.');
  }
  return { kind: 'assistant-doctor', ok: checks.every(item => item.ok), mode: 'offline', checks,
    unverified: ['OAuth consent and token validity', 'Telegram bot ownership, webhook and pairing', 'Model provider credential and access', 'Persisted profile binding and recovery', 'Live delivery and Calendar permissions'] };
}
