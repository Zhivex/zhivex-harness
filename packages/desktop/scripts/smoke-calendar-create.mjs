// Installed Node consumer; Google HTTP and OAuth credentials are fixtures.
import {createCalendarService} from '@zhivex-ai/harness/assistant/calendar/calendar';
import {openCalendarStore} from '@zhivex-ai/harness/assistant/calendar/store';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const directory = await mkdtemp('/tmp/zhx-calendar-create-node-'), key = randomBytes(32).toString('base64');
let store, event, posts = 0;
const credentials = {connectionId: 'fixture-connection', accountId: 'fixture-account', accessToken: 'fixture-token'};
const oauth = {credentials: () => credentials, freshCredentials: async () => credentials};
const fetcher = async (url, init) => {
  assert(String(url).startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events'));
  if (init.method === 'POST') {posts++; event = {...JSON.parse(init.body), etag: 'v1'}; throw new Error('fixture lost response after acceptance');}
  return event ? Response.json(event) : Response.json({}, {status: 404});
};
try {
  store = await openCalendarStore(directory, key);
  let service = createCalendarService(store, oauth, {fetcher}).creation;
  const proposal = service.propose({requestId: randomUUID(), summary: 'Installed consumer event', start: '2026-11-14T12:00:00Z', end: '2026-11-14T13:00:00Z', attendees: ['guest@example.test']});
  const ref = service.reference(proposal); assert.equal(posts, 0);
  assert.equal((await service.apply(ref)).status, 'confirmed'); assert.equal(posts, 1);
  await store.close(); store = await openCalendarStore(directory, key);
  service = createCalendarService(store, oauth, {fetcher}).creation;
  assert.equal((await service.apply(ref)).status, 'confirmed'); assert.equal(posts, 1);
  console.log(JSON.stringify({passed: true, runtime: 'installed Node', checks: ['proposal has no POST', 'lost response reconciled by stable event ID', 'restart does not repeat creation'], posts, limitations: 'Google HTTP and OAuth credentials are simulated; no real event or notification.'}, null, 2));
} finally {await store?.close(); await rm(directory, {recursive: true, force: true});}
