import type { CalendarConnectionOptions } from './connection.js';
export function calendarEnvironment(calendarId = 'primary'): CalendarConnectionOptions {
  return { clientId: process.env.ASSISTANT_GOOGLE_CLIENT_ID ?? '', encryptionKey: process.env.ASSISTANT_CREDENTIAL_KEY ?? '',
    ...(process.env.ASSISTANT_GOOGLE_CLIENT_SECRET ? { clientSecret: process.env.ASSISTANT_GOOGLE_CLIENT_SECRET } : {}), calendarId };
}
