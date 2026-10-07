// Offline evaluation preload. No network passthrough, SDK patch, receipt fabrication or product fallback.
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const root = process.env.CODE_TASK_FIXTURE_ROOT;
if (!root) throw Error('TASK_FIXTURE_ROOT_REQUIRED');
const record = path.join(root, 'requests.jsonl');
const stateFile = path.join(root, 'provider-state.json');
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== 'https://api.openai.com/v1/responses') throw Error('OFFLINE_NETWORK_BLOCKED');
  const body = JSON.parse(options.body);
  const users = (Array.isArray(body.input) ? body.input : []).filter(m => m.role === 'user');
  const goal = JSON.stringify(users.map(message => message.content));
  if (/Verify the corrected requirement/.test(goal) && !state.continuationSeen) {
    state.continuationSeen = true; state.checked = false;
  }
  appendFileSync(record, JSON.stringify({ request: randomUUID(), maxOutputTokens: body.max_output_tokens ?? null }) + '\n');
  const workspace = process.env.CODE_TASK_FIXTURE_WORKSPACE;
  return new globalThis.Response(new globalThis.ReadableStream({
    start(controller) {
      const send = event => controller.enqueue(new globalThis.TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
      const tool = (name, input) => {
        const id = randomUUID();
        send({ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', id: 'fc_' + id, call_id: 'call_' + id, name, arguments: JSON.stringify(input) } });
      };
      if (/slow-cancel/.test(goal) && !state.interrupted) {
        state.interrupted = true; writeFileSync(stateFile, JSON.stringify(state));
        send({ type: 'response.output_text.delta', delta: 'Synthetic provider is waiting. Cancellation cannot prove provider termination.' });
        const stop = () => setTimeout(() => {
          try { controller.error(new globalThis.DOMException('Synthetic interrupted response', 'AbortError')); } catch { /* Stream already closed. */ }
        }, 1000);
        options.signal?.addEventListener('abort', stop, { once: true });
        if (options.signal?.aborted) stop();
        return;
      }
      const before = readFileSync(path.join(workspace, 'greeting.mjs'), 'utf8');
      if (!before.startsWith('// Reviewed greeting')) {
        tool('apply_reviewed_edits', { changes: [{ path: 'greeting.mjs',
          expectedDigest: 'sha256:' + createHash('sha256').update(before).digest('hex'),
          content: '// Reviewed greeting\n// Literal <img onerror=alert(1)>\n' + before }] });
      } else if (!state.checked) {
        state.checked = true;
        tool('run_check', { check: 'test', expectedScript: 'node check.mjs' });
      } else send({ type: 'response.output_text.delta', delta: 'Synthetic delivery complete. Human review remains separate. Literal <img onerror=alert(1)>.' });
      writeFileSync(stateFile, JSON.stringify(state));
      send({ type: 'response.completed', response: { id: 'resp_' + randomUUID(), status: 'completed',
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
};
