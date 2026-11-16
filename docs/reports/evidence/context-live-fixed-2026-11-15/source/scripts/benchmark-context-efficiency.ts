import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import type { AgentRunState, ModelMessage } from '@zhivex-ai/core';
import { createRequestProjection, createResultIndex } from '../packages/core/src/context/request-projection.js';
import { estimateMessages } from '../packages/core/src/context/adaptive-compaction.js';
import { discoverNewHarnessScopedContext, refreshHarnessScopedContext, refreshAndDiscoverHarnessScopedContext,
  type HarnessScopedContextState } from '../packages/core/src/context/scoped-context.js';

// Offline paired microbenchmarks. Baselines reproduce the previous algorithms;
// they do not estimate provider billing or include store deserialization/network.
const measure = async (work: () => unknown | Promise<unknown>) => {
  const start = performance.now(); await work(); return performance.now() - start;
};
const paired = async (before: () => unknown | Promise<unknown>, after: () => unknown | Promise<unknown>, count = 25) => {
  for (let i = 0; i < 3; i++) { await before(); await after(); }
  const old: number[] = [], next: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 2) { next.push(await measure(after)); old.push(await measure(before)); }
    else { old.push(await measure(before)); next.push(await measure(after)); }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  return { samples: count, beforeMedianMs: median(old), afterMedianMs: median(next), speedup: median(old) / median(next) };
};
const id = (name: string, output: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify([name, output])).digest('hex');
const results = Array.from({ length: 128 }, (_, i) => ({ toolName: 'read_file', toolCallId: `read-${i}`,
  output: { path: `${i}.ts`, content: `${i}\n` + 'abcdef\n'.repeat(1800) + 'MIDDLE_REQUIRED\n' + 'tail\n'.repeat(200) }, isError: false }));
const state = { runId: 'benchmark', revision: 1, toolResults: results } as unknown as AgentRunState;
const projection = createRequestProjection(async () => state); projection.observe(state);
const messages: ModelMessage[] = [];
let beforeTokens = 0, afterTokens = 0;
for (const result of results.slice(0, 8)) {
  messages.push({ role: 'assistant', parts: [{ type: 'tool-call', toolCall: { id: result.toolCallId, name: result.toolName, input: { path: result.output.path } } }] },
    { role: 'tool', parts: [{ type: 'tool-result', toolResult: result }] });
  beforeTokens += estimateMessages(messages);
  afterTokens += estimateMessages(projection.measureMessages(messages));
}
assert(afterTokens <= beforeTokens);
assert.equal(state.toolResults.length, 128);
const index = createResultIndex();
const lookupResults = results.map(result => ({ ...result, toolName: 'run_check', output: { stdout: result.output.content, stderr: '', exitCode: 0 } }));
const lookupState = { ...state, toolResults: lookupResults };
const target = lookupResults.at(-1)!; const targetId = id(target.toolName, target.output);
const lookupBefore = () => {
  for (let page = 0; page < 6; page++) {
    const source = lookupResults.find(result => id(result.toolName, result.output) === targetId)!;
    assert.equal(JSON.stringify(source.output).slice(page * 4000, page * 4000 + 4000), JSON.stringify(target.output).slice(page * 4000, page * 4000 + 4000));
  }
};
let revision = 1;
const lookupAfter = () => {
  for (let page = 0; page < 6; page++) {
    const source = index({ ...lookupState, revision: ++revision }).get(targetId)!;
    assert.equal(source.text.slice(page * 4000, page * 4000 + 4000), JSON.stringify(target.output).slice(page * 4000, page * 4000 + 4000));
  }
};
const resultLookup = await paired(lookupBefore, lookupAfter);
const root = await mkdtemp('/tmp/harness-context-efficiency-');
try {
  let scoped: HarnessScopedContextState = { schemaVersion: 1, entries: [] };
  for (let i = 0; i < 64; i++) {
    await mkdir(`${root}/group-${i}`); await writeFile(`${root}/group-${i}/AGENTS.md`, `Group ${i}: use Bun and preserve approvals.\n`);
    scoped.entries.push({ path: `group-${i}/AGENTS.md`, digest: null, bytes: 0 });
  }
  scoped = (await refreshHarnessScopedContext({ root }, scoped)).state;
  const paths = [0, 1, 2, 3].map(i => `group-${i}/file.ts`);
  const baseline = async () => {
    let current = scoped;
    for (const path of paths) current = (await refreshAndDiscoverHarnessScopedContext({ root }, { paths: [path], state: current })).state;
    return refreshHarnessScopedContext({ root }, current);
  };
  const optimized = async () => {
    let current = scoped;
    for (const path of paths) current = await discoverNewHarnessScopedContext({ root }, { paths: [path], state: current });
    return refreshHarnessScopedContext({ root }, current);
  };
  assert.deepEqual(await optimized(), await baseline());
  const scopedRefresh = await paired(baseline, optimized);
  const report = {
    schemaVersion: 1, bun: Bun.version,
    methodology: 'Offline synthetic workloads; short repeated lines intentionally exercise lossless fallback with no token savings; 3 warmups; 25 alternating pairs; medians. Tokens use the harness character estimator, messages only, across 8 requests. Lookup changes durable revision between each page; excludes store I/O. Scope baseline retains old refresh frequency but uses the improved linear validator, conservatively understating the full improvement.',
    messageTokens: { before: beforeTokens, after: afterTokens, reductionPercent: 100 * (1 - afterTokens / beforeTokens) },
    resultLookup,
    scopedRefresh: { ...scopedRefresh, beforeSourceReads: 320, afterSourceReads: 64, scopes: 64, toolReads: 4 },
    assertions: { exactPageRecovery: true, unchangedDurableResults: true, identicalScopedInstructions: true }
  };
  if (process.argv.includes('--assert-improvement')) {
    assert(afterTokens <= beforeTokens, 'lossless fallback must not inflate historical reads');
    assert(resultLookup.speedup > 1.2, 'lookup median did not improve');
    assert(scopedRefresh.speedup > 1.2, 'scoped refresh median did not improve');
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
