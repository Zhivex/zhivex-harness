// Synthetic raw Responses receipts: no socket, paid request or real credential.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cases = JSON.parse(readFileSync(new URL('./meta-responses-usage.json', import.meta.url), 'utf8'));
let selected = process.env.META_USAGE_CASE ?? 'reasoning-790';
globalThis.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  assert.equal(url, 'https://meta-fixture.invalid/v1/responses');
  const receipt = cases.find(value => value.name === selected);
  assert(receipt, `Unknown usage fixture ${selected}`);
  const value = { id: 'resp_meta_usage_fixture', status: 'completed', usage: receipt.usage,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'installed-meta-ok' }] }] };
  if (JSON.parse(options.body).stream !== true) return Response.json(value);
  return new Response([
    { type: 'response.output_text.delta', delta: 'installed-meta-ok' },
    { type: 'response.completed', response: value },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

// Resolve through the installed Harness, including pnpm's isolated dependency graph.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const harnessManifestPath = realpathSync(path.resolve('node_modules/@zhivex-ai/harness/package.json'));
  const harness = JSON.parse(readFileSync(harnessManifestPath, 'utf8'));
  assert.equal(harness.dependencies['@zhivex-ai/meta'], '0.2.9');
  const resolve = createRequire(harnessManifestPath);
  // Meta is import-only; require.resolve(package) would select an unsupported condition.
  const metaManifestPath = resolve.resolve.paths('@zhivex-ai/meta')
    .map(directory => path.join(directory, '@zhivex-ai/meta/package.json')).find(existsSync);
  assert(metaManifestPath, 'Harness has no installed Meta dependency');
  const metaManifest = JSON.parse(readFileSync(metaManifestPath, 'utf8'));
  const metaEntry = path.resolve(path.dirname(metaManifestPath), metaManifest.exports['.'].import);
  assert.equal(metaManifest.version, '0.2.9');
  const { createMeta } = await import(pathToFileURL(metaEntry).href);
  const model = createMeta({ apiKey: 'installed-fixture-only', baseURL: 'https://meta-fixture.invalid/v1' })('muse-spark-1.3');
  for (const receipt of cases) for (const mode of ['generate', 'stream']) {
    selected = receipt.name;
    const input = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'fixture' }] }], providerOptions: { apiMode: 'responses' } };
    let usage;
    if (mode === 'generate') usage = (await model.generate(input)).usage;
    else for await (const event of await model.stream(input)) if (event.type === 'finish') usage = event.usage;
    assert.deepEqual(JSON.parse(JSON.stringify(usage ?? {})), receipt.expected, `${receipt.name}/${mode}`);
  }
  console.log(JSON.stringify({ meta: metaManifest.version, corePin: harness.dependencies['@zhivex-ai/core'],
    cases: cases.map(value => value.name), modes: ['generate', 'stream'] }));
}
