// Only loaded by the PTY smoke child. No request leaves this process.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
let editRequested = existsSync(process.env.CONSOLE_FIXTURE_REQUESTS) &&
  readFileSync(process.env.CONSOLE_FIXTURE_REQUESTS, 'utf8').includes('EDIT_FIXTURE');
let slowRequested = false;
let failedRequested = false;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions') {
    if (new Headers(options.headers).get('authorization') !== 'Bearer qwen-hidden-fixture') throw new Error('Qwen managed credential was not selected');
    const body = JSON.parse(options.body);
    appendFileSync(process.env.CONSOLE_FIXTURE_REQUESTS, JSON.stringify(body) + '\n');
    return Response.json({ id: 'qwen-probe', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
  }
  if (!String(url).startsWith('https://api.openai.com/v1/')) throw new Error('Unexpected fixture endpoint');
  if (process.env.CONSOLE_EXPECT_API_KEY) {
    if (process.env.OPENAI_API_KEY) throw new Error('Managed key leaked to process environment');
    if (new Headers(options.headers).get('authorization') !== `Bearer ${process.env.CONSOLE_EXPECT_API_KEY}`) {
      throw new Error('Expected replacement credential was not used');
    }
  }
  const body = JSON.parse(options.body);
  appendFileSync(process.env.CONSOLE_FIXTURE_REQUESTS, JSON.stringify(body) + '\n');
  if (JSON.stringify(body).includes("WAIT_FIXTURE")) await new Promise(resolve => setTimeout(resolve, 1500));
  const slow = !slowRequested && JSON.stringify(body).includes('SLOW_FIXTURE');
  if (slow) slowRequested = true;
  const fail = !failedRequested && JSON.stringify(body).includes('FAIL_STREAM_FIXTURE');
  if (fail) failedRequested = true;
  let abort;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      abort = () => controller.error(new DOMException('Fixture interrupted', 'AbortError'));
      if (slow) {
        send({ type: 'response.output_text.delta', delta: 'Cancellable partial' });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        return;
      }
      if (fail) {
        send({ type: 'response.output_text.delta', delta: 'Recoverable partial\u001b[2J' });
        setTimeout(() => controller.error(new Error('Fixture provider disconnected')), 350);
        return;
      }
      if (!editRequested && JSON.stringify(body).includes('EDIT_FIXTURE')) {
        editRequested = true;
        send({ type: 'response.output_item.done', item: { type: 'function_call', status: 'completed', id: 'fc_fixture', call_id: 'call_fixture', name: 'apply_reviewed_edits', arguments: JSON.stringify({ changes: [{ path: 'result.txt', expectedDigest: null, content: 'approved fixture edit\n' }] }) } });
      } else send({ type: 'response.output_text.delta', delta: 'Fixture done' });
      send({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
      controller.close();
    },
    cancel() { if (abort) options.signal?.removeEventListener('abort', abort); }
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
};
