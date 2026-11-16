import {z} from 'zod';
import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomBytes, randomUUID} from 'node:crypto';
import {openCalendarStore} from '../packages/core/src/application/assistant/calendar/store.js';
import {createCalendarService} from '../packages/core/src/application/assistant/calendar/calendar.js';
import {calendarEngineOptions, calendarApprovalDetails} from '../packages/core/src/application/assistant/calendar/tools.js';
import {attachCalendarCreation} from '../packages/core/src/application/calendar-review.js';

test('creation requires explicit tool capability, uses a stored reference and projects exact approval details', async () => {
  const root = await mkdtemp('/tmp/zhx-create-tools-'), store = await openCalendarStore(root, randomBytes(32).toString('base64'));
  const credentials = {connectionId: 'connection', accountId: 'account', accessToken: 'fixture'};
  let posts = 0;
  const service = createCalendarService(store, {credentials: () => credentials, freshCredentials: async () => credentials} as any, {fetcher: async (_url, init) => {
    if (init?.method === 'POST') {posts++; return Response.json({...JSON.parse(String(init.body)), etag: 'v1'});} throw new Error('unexpected request');
  }});
  try {
    const legacy = calendarEngineOptions(service), enabled = calendarEngineOptions(service, true);
    expect(legacy.agentProfile.version).toBe('1'); expect(enabled.agentProfile.version).toBe('2');
    expect(legacy.agentProfile.toolNames).not.toContain('calendar_write_create');
    expect(enabled.agentProfile.toolNames).toContain('calendar_write_create');
    await expect(legacy.mcpClients.calendar_write.callTool({name: 'create', arguments: {}})).rejects.toThrow('CALENDAR_TOOL_UNKNOWN');
    await expect(legacy.mcpClients.calendar_read.callTool({name: 'propose_create', arguments: {}})).rejects.toThrow('CALENDAR_TOOL_UNKNOWN');
    const input = {requestId: randomUUID(), summary: 'Create after review', start: '2026-11-14T12:00:00Z', end: '2026-11-14T13:00:00Z', attendees: ['guest@example.test']};
    const result = await enabled.mcpClients.calendar_read.callTool({name: 'propose_create', arguments: input});
    const toolText = (value: unknown) => z.object({content: z.array(z.object({text: z.string()})).min(1)}).parse(value).content[0]!.text;
    const ref = JSON.parse(toolText(result)); expect(posts).toBe(0);
    const details = await calendarApprovalDetails(service)({approvals: [{approvalId: 'a', action: {name: 'calendar_write_create', arguments: JSON.stringify(ref)}}]} as any);
    const item = {approvalId: 'a', digest: 'a'.repeat(64), expiresAt: Date.now() + 3600000, name: 'calendar_write_create', payloadDigest: 'sha256:x', payload: '{}', files: [], commands: [], consequence: '', complete: true};
    attachCalendarCreation(item, details[0]);
    expect((item as any).calendarCreation).toMatchObject({after: {summary: input.summary}, attendees: input.attendees});
    expect(item.expiresAt).toBe(details[0]!.proposal.expiresAt);
    const applied = await enabled.mcpClients.calendar_write.callTool({name: 'create', arguments: ref});
    expect(JSON.parse(toolText(applied)).status).toBe('confirmed'); expect(posts).toBe(1);
    await enabled.mcpClients.calendar_write.callTool({name: 'create', arguments: ref}); expect(posts).toBe(1);
    const after = await calendarApprovalDetails(service)({approvals: [{approvalId: 'a', action: {name: 'calendar_write_create', arguments: JSON.stringify(ref)}}]} as any);
    const next = {...item, complete: true}; attachCalendarCreation(next, after[0]); expect(next.complete).toBe(false);
  } finally {await store.close(); await rm(root, {recursive: true, force: true});}
});
