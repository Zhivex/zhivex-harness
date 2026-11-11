import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { openCalendarStore } from './store.js';
import { createCalendarOAuth, type CalendarOAuthOptions } from './oauth.js';

export interface CalendarConnectionOptions extends CalendarOAuthOptions {
  encryptionKey: string; calendarId?: string;
}
export async function openCalendarConnection(directory: string, ownerId: string, options: CalendarConnectionOptions, recover = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ownerId)) throw new Error('CALENDAR_OWNER_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('CALENDAR_STATE_UNSAFE');
  const store = await openCalendarStore(path.join(directory, 'state'), options.encryptionKey, recover);
  try {
    if (store.meta('owner') && store.meta('owner') !== ownerId) throw new Error('CALENDAR_OWNER_MISMATCH');
    store.set('owner', ownerId);
    const oauth = createCalendarOAuth(store, options);
    return { store, oauth, close: () => store.close() };
  } catch (error) { await store.close(); throw error; }
}
