import { createDailyModule } from '../../dist/index.js';
const directory = process.argv[2], recovering = process.argv[3] === 'recover';
let now = Date.parse('2026-11-11T00:00:00Z');
const instance = await createDailyModule({ now: () => now }).open({ directory, ownerId: 'owner', recover: recovering });
let sends = 0;
instance.start({ notifications: { ready: () => true, async send() {
  sends++; console.log('sending'); await new Promise(() => {});
} } });
if (!recovering) instance.daily.scheduleReminder({ requestId: '11111111-1111-4111-8111-111111111111', text: 'Reminder crash test', date: '2026-11-11', localTime: '09:00', timeZone: 'UTC', channel: 'telegram' });
now = Date.parse('2026-11-11T09:00:00Z');
const keepAlive = setInterval(() => {}, 10000);
await instance.daily.tick();
if (recovering) { console.log(JSON.stringify({ sends, reminders: instance.daily.listReminders() })); await instance.close(); clearInterval(keepAlive); }
