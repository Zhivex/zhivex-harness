import {test, expect} from 'bun:test';
import {createServer, request} from 'node:http';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createMockLanguageModel} from '@zhivex-ai/agents/testing';
import {createHarness} from '../packages/core/src/runtime/harness.js';
import {startApplicationHost} from '../packages/core/src/application/host.js';
import {connectApplication} from '../packages/core/src/application/client.js';

test('lost approval response reconciles from another client without repeating the approved effect', async () => {
  const root = await mkdtemp('/tmp/zhx-lost-');
  await writeFile(root + '/note.txt', 'before');
  const harness = await createHarness({workspace: root, subagentProfiles: [], modelInstance: createMockLanguageModel({streamEvents: [[
    {type: 'tool-call', toolCall: {id: 'edit', name: 'apply_reviewed_replacement', input: {path: 'note.txt', expectedDigest: 'sha256:' + createHash('sha256').update('before').digest('hex'), oldText: 'before', newText: 'after'}}},
    {type: 'finish', finishReason: 'tool-calls'},
  ], [{type: 'text-delta', textDelta: 'Saved once.'}, {type: 'finish', finishReason: 'stop'}]]}),
    toolPolicy: {schemaVersion: 1, explicitReview: {schemaVersion: 1}, rules: []}});
  const host = await startApplicationHost(harness, {directory: root + '/host', maxEvents: 3});
  const credentials = JSON.parse(await readFile(host.credentialsPath, 'utf8'));
  let decisions = 0;
  // Forward the authenticated request intact, then lose the response after the host commits.
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = request({socketPath: host.socketPath, path: incoming.url, method: incoming.method, headers: incoming.headers}, response => {
      if (incoming.url === '/decision' && ++decisions === 1) {
        response.resume(); response.on('end', () => outgoing.destroy());
      } else {outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);}
    });
    forwarded.on('error', () => outgoing.destroy()); incoming.pipe(forwarded);
  });
  await new Promise<void>(resolve => proxy.listen(root + '/proxy.sock', resolve));
  await writeFile(root + '/proxy.json', JSON.stringify({...credentials, socketPath: root + '/proxy.sock'}), {mode: 0o600});
  try {
    const desktop = await connectApplication(root + '/proxy.json'), cli = await connectApplication(host.credentialsPath);
    const created = await cli.command({method: 'session.create', idempotencyKey: 'new'});
    if (!created.ok || created.data.kind !== 'session') throw new Error('SESSION_FAILED');
    const session = created.data.session;
    const started = await cli.command({method: 'run.start', sessionId: session.sessionId, expectedRevision: session.revision, idempotencyKey: 'run', prompt: 'Edit note'});
    if (!started.ok || started.data.kind !== 'run') throw new Error('RUN_FAILED');
    const run = started.data.run;
    const review = await desktop.review(session.sessionId, run.runId);
    if (!review.ok) throw new Error('REVIEW_FAILED');
    await expect(desktop.decide(review.review.ticketId, true)).rejects.toThrow(/LOCAL_SERVICE_(UNAVAILABLE|RESPONSE_INVALID)/);
    expect(decisions).toBe(1);
    expect(await cli.command({method: 'run.get', sessionId: session.sessionId, runId: run.runId})).toMatchObject({ok: true, data: {run: {status: 'completed'}}});
    expect(await readFile(root + '/note.txt', 'utf8')).toBe('after');
    await expect(desktop.decide(review.review.ticketId, true)).rejects.toThrow();
    expect(await readFile(root + '/note.txt', 'utf8')).toBe('after');
    const recovered = await cli.events(session.sessionId, 0);
    expect(recovered.cursorExpired).toBe(true);
    expect(recovered.snapshot).toBeDefined();
    expect((await cli.events(session.sessionId, recovered.nextCursor)).events).toEqual([]);
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await host.close(); await rm(root, {recursive: true, force: true});
  }
});
