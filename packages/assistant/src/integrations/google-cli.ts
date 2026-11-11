import { calendarEnvironment } from '../calendar/cli.js';
import { startCalendarAuthorization } from '../calendar/oauth.js';
import { openGoogleConnection } from './google.js';

export async function googleCommand(action: 'connect' | 'status' | 'disconnect', directory: string, owner: string, config: { mail: boolean; drive: boolean }, recover: boolean) {
  const connection = await openGoogleConnection(directory, owner, { ...calendarEnvironment(), ...config }, recover);
  try {
    if (action === 'disconnect') { console.log(JSON.stringify(await connection.oauth.disconnect())); return; }
    if (action === 'status') {
      try { const value = connection.oauth.credentials(); console.log(JSON.stringify({ connected: true, account: value.email, ...config })); }
      catch { console.log(JSON.stringify({ connected: false })); }
      return;
    }
    const flow = await startCalendarAuthorization(connection.oauth), cancel = () => flow.close();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try { console.log(JSON.stringify({ kind: 'google-authorization', url: flow.url })); console.log(JSON.stringify({ kind: 'google-connected', account: await flow.result })); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  } finally { await connection.close(); }
}
