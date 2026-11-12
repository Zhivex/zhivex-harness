import { openCalendarConnection, type CalendarConnectionOptions } from './connection.js';
import { startCalendarAuthorization } from './oauth.js';
export function calendarEnvironment(calendarId = 'primary'): CalendarConnectionOptions {
  return { clientId: process.env.ASSISTANT_GOOGLE_CLIENT_ID ?? '', encryptionKey: process.env.ASSISTANT_CREDENTIAL_KEY ?? '',
    ...(process.env.ASSISTANT_GOOGLE_CLIENT_SECRET ? { clientSecret: process.env.ASSISTANT_GOOGLE_CLIENT_SECRET } : {}), calendarId };
}
export async function calendarCommand(action: 'connect' | 'disconnect' | 'status', directory: string, owner: string, recover: boolean) {
  const connection = await openCalendarConnection(directory, owner, calendarEnvironment(), recover);
  try {
    if (action === 'disconnect') { console.log(JSON.stringify(await connection.oauth.disconnect())); return; }
    if (action === 'status') {
      try { const value = connection.oauth.credentials(); console.log(JSON.stringify({ connected: true, account: value.email, connectionId: value.connectionId })); }
      catch { console.log(JSON.stringify({ connected: false, reauthorizationRequired: connection.store.meta('reauthorize') === 'yes' })); }
      return;
    }
    const flow = await startCalendarAuthorization(connection.oauth);
    const cancel = () => flow.close(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try { console.log(JSON.stringify({ kind: 'calendar-authorization', url: flow.url })); console.log(JSON.stringify({ kind: 'calendar-connected', account: await flow.result })); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  } finally { await connection.close(); }
}
