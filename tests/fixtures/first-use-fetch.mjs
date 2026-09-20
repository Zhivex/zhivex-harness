// Offline transport, accepted only for a disposable fixture credential.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.openai.com/v1/')) throw new Error('Unexpected fixture endpoint');
  const header = new Headers(options.headers).get('authorization');
  if (header !== 'Bearer first-use-fixture-only') return Response.json({ error: { message: 'Invalid fixture credentials' } }, { status: 401 });
  if (process.env.FIRST_USE_UNAVAILABLE === '1') return Response.json({ error: { message: 'Fixture unavailable' } }, { status: 503 });
  const counter = process.env.FIRST_USE_COUNTER;
  const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
  const calls = [
    ['read_file', { path: 'package.json' }],
    ['apply_reviewed_edits', { changes: [{ path: 'result.txt', expectedDigest: null, content: 'first use passed\n' }] }],
    ['run_check', { check: 'pilot', expectedScript: 'bun run pilot-check.ts' }],
    ['git_diff', {}]
  ];
  const events = n < calls.length
    ? [{ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', id: `fc_${n}`, call_id: `call_${n}`, name: calls[n][0], arguments: JSON.stringify(calls[n][1]) } }]
    : [{ type: 'response.output_text.delta', delta: 'First-use edit, approved check and diff completed.' }];
  events.push({ type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
