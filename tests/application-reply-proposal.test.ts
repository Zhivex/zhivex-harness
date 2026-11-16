import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {openDailyService} from '../packages/core/src/application/assistant/daily/service.js';

test('reply proposals survive restart, bind the source, expire and apply idempotently', async () => {
  const directory = await mkdtemp('/tmp/reply-proposal-'); let now = Date.parse('2026-11-15T12:00:00Z');
  let daily = await openDailyService(directory, 'owner', false, () => now);
  const source = {id: 'google', binding: 'account-one', async read() {return {complete: false, messages: []};}};
  const input = {requestId: randomUUID(), source: 'google', threadId: 'thread', baselineMessageId: 'baseline', expectedFrom: 'guest@example.test', title: 'Reply', dueAt: '2026-11-16T12:00:00Z'};
  try {
    daily.proactive.bind({replies: [source]});
    const ref = daily.proactive.proposeWatch(input);
    expect(daily.proactive.status().watches).toHaveLength(0);
    expect(() => daily.proactive.proposeWatch({...input, expectedFrom: 'other@example.test'})).toThrow('CONFLICT');
    expect(() => daily.proactive.applyWatch({...ref, proposalDigest: '0'.repeat(64)})).toThrow('CHANGED');
    await daily.close(); daily = await openDailyService(directory, 'owner', false, () => now);
    daily.proactive.bind({replies: [{...source, binding: 'account-two'}]});
    expect(() => daily.proactive.applyWatch(ref)).toThrow('SOURCE_CHANGED');
    daily.proactive.bind({replies: [source]});
    expect(daily.proactive.reviewWatch(ref).expectedFrom).toBe(input.expectedFrom);
    expect(daily.proactive.applyWatch(ref)).toEqual({watchId: input.requestId});
    expect(daily.proactive.applyWatch(ref)).toEqual({watchId: input.requestId});
    expect(daily.proactive.status().watches).toHaveLength(1);
    daily.proactive.cancelWatch({watchId: input.requestId});
    expect(daily.proactive.status().watches[0]?.status).toBe('cancelled');
    now += 16 * 60000;
    expect(() => daily.proactive.applyWatch(ref)).toThrow('EXPIRED');
  } finally {await daily.close(); await rm(directory, {recursive: true, force: true});}
});
