// Node preload: deterministic provider transport, no socket and no credentials.
globalThis.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (url !== 'https://api.openai.com/v1/responses') throw new Error(`Unexpected fixture request: ${url}`);
  const value = { id: 'resp_installed', status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'installed-cli-ok', annotations: [] }] }] };
  if (JSON.parse(options.body).stream !== true) return Response.json(value);
  return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'installed-cli-ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: value })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
