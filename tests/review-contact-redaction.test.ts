import {test, expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {createApplicationReviewChannel} from '../packages/core/src/application/review-channel.js';
import type {HarnessClientAdapter} from '../packages/core/src/client/protocol.js';

test('trusted contact review can show recipients while still removing credentials', async () => {
  const run = {runId: 'run', revision: 1, status: 'waiting_approval', output: '', approvals: []};
  const adapter = {dispatch: async () => ({ok: true, data: {kind: 'run', run}})} as unknown as HarnessClientAdapter;
  let ordinary = '', contacts = '';
  const channel = createApplicationReviewChannel(adapter, ['private-fixture-secret'], {project: async (_run, redact, redactContacts) => {
    const text = 'Notify guest@example.test; private-fixture-secret; sk-liveFixtureToken';
    ordinary = redact(text); contacts = redactContacts(text);
    return {schemaVersion: 1, runId: run.runId, revision: run.revision, status: run.status, items: []};
  }});
  const result = await channel.review({clientId: randomUUID(), request: {protocolVersion: 1, requestId: 'review', connectionId: 'connection', command: {method: 'run.get', projectId: 'project', sessionId: 'session', runId: 'run', includeReview: true}}});
  expect(result.ok).toBe(true);
  expect(ordinary).not.toContain('guest@example.test');
  expect(contacts).toContain('guest@example.test');
  for (const text of [ordinary, contacts]) {expect(text).not.toContain('private-fixture-secret'); expect(text).not.toContain('sk-liveFixtureToken');}
});
