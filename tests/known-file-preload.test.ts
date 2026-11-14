import { test, expect } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { createInMemoryAgentRunStore } from '@zhivex-ai/agents/ops';
import { createHarness, runHarnessTask, type CreateHarnessOptions } from '../src/runtime/harness.js';

async function fixture(extra: Partial<CreateHarnessOptions> = {}) {
  const root = await mkdtemp('/tmp/known-preload-');
  await mkdir(root + '/src');
  await writeFile(root + '/src/file.ts', 'export const marker = "SNAPSHOT_CONTENT";\nsecond line\n');
  await writeFile(root + '/src/AGENTS.md', 'SCOPED_RULE: preserve API compatibility.');
  const requests: string[] = [];
  const model = createMockLanguageModel({ streamEvents: Array.from({ length: 2 }, () => [{ type: 'text-delta' as const, textDelta: 'done' }, { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: 10, outputTokens: 1 } }]) });
  const stream = model.stream!; model.stream = input => { requests.push(JSON.stringify(input.messages)); return stream(input); };
  const harness = await createHarness({ workspace: root, modelInstance: model, provider: 'openai', subagentProfiles: [], store: createInMemoryAgentRunStore(), ...extra });
  return { root, harness, requests, close: async () => { await harness.close(); await rm(root, { recursive: true, force: true }); } };
}
const preloadFiles = { files: [{ path: 'src/file.ts', startLine: 1, endLine: 1 }] };
test('opt-in loads scoped instructions and bounded snapshot on first call, persists provenance and telemetry', async () => {
  const f = await fixture(); let telemetry: any;
  try {
    const result = await runHarnessTask(f.harness, { prompt: 'Review the module' }, { preloadFiles, onTaskTelemetry: t => { telemetry = t; } });
    expect(result.status).toBe('completed'); expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toContain('SNAPSHOT_CONTENT'); expect(f.requests[0]).not.toContain('second line');
    expect(f.requests[0]).toContain('SCOPED_RULE');
    expect(result.state.metadata?.zhivexKnownFilePreload).toMatchObject({ toolName: 'read_files', requests: preloadFiles.files });
    expect(result.state.metadata?.zhivexScopedContext).toMatchObject({ entries: [{ path: 'src/AGENTS.md' }] });
    expect(telemetry.operationTotals.tool.count).toBe(1);
    await expect(runHarnessTask(f.harness, { state: result.state }, { preloadFiles })).rejects.toThrow('PRELOAD_UNSUPPORTED');
  } finally { await f.close(); }
});
test('omission does not load known files or scoped guidance', async () => {
  const f = await fixture(); try { await runHarnessTask(f.harness, { prompt: 'Review the module' });
    expect(f.requests[0]).not.toContain('SNAPSHOT_CONTENT'); expect(f.requests[0]).not.toContain('SCOPED_RULE');
  } finally { await f.close(); }
});
for (const decision of ['deny', 'ask_user'] as const) test(`preload cannot bypass ${decision} tool policy`, async () => {
  const f = await fixture({ toolPolicy: { schemaVersion: 1, rules: [{ id: 'restricted', tools: ['read_files'], decision, reason: 'restricted read' }] } });
  try { await expect(runHarnessTask(f.harness, { prompt: 'Review' }, { preloadFiles })).rejects.toThrow(); expect(f.requests).toHaveLength(0); }
  finally { await f.close(); }
});
for (const bad of ['../outside.txt', '.env', 'missing.txt', 'linked.txt', 'large.txt', 'binary.txt']) test(`preload rejects unsafe or unavailable input: ${bad}`, async () => {
  const f = await fixture();
  try {
    await writeFile(f.root + '/.env', 'secret'); await symlink('src/file.ts', f.root + '/linked.txt');
    await writeFile(f.root + '/large.txt', 'x'.repeat(1024 * 1024 + 1)); await writeFile(f.root + '/binary.txt', Buffer.from([0,1,2]));
    await expect(runHarnessTask(f.harness, { prompt: 'Review' }, { preloadFiles: { files: [{ path: bad }] } })).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
});
test('serialized limit, invalid ranges, count, cancellation, missing catalog and overrides fail before model', async () => {
  const f = await fixture();
  try {
    await expect(runHarnessTask(f.harness, { prompt: 'Review' }, { preloadFiles: { ...preloadFiles, maxBytes: 1 } })).rejects.toThrow('PRELOAD_CONTEXT_LIMIT');
    await expect(runHarnessTask(f.harness, { prompt: 'Review' }, { preloadFiles: { files: [{ path: 'src/file.ts', startLine: 2, endLine: 1 }] } })).rejects.toThrow();
    expect(() => runHarnessTask(f.harness, { prompt: 'Review' }, { preloadFiles: { files: Array(21).fill({ path: 'src/file.ts' }) } })).toThrow();
    await expect(runHarnessTask(f.harness, { prompt: 'Review', abortSignal: AbortSignal.abort() }, { preloadFiles })).rejects.toThrow();
    await expect(runHarnessTask(f.harness, { prompt: 'Review', tools: {} }, { preloadFiles })).rejects.toThrow('PRELOAD_UNSUPPORTED');
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
  const noReader = await fixture({ toolNames: [] });
  try { await expect(runHarnessTask(noReader.harness, { prompt: 'Review' }, { preloadFiles })).rejects.toThrow('PRELOAD_UNSUPPORTED'); }
  finally { await noReader.close(); }
});

test('path-scoped deny is applied before reading an otherwise available file', async () => {
  const f = await fixture({ toolPolicy: { schemaVersion: 1, rules: [{ id: 'private', tools: ['read_files'], paths: ['src/file.ts'], decision: 'deny', reason: 'private' }] },
    toolPolicyPaths: (_name,input) => (input as {files:{path:string}[]}).files.map(f=>f.path), toolPolicyPathsVersion: 'test-v1' });
  try { await expect(runHarnessTask(f.harness,{prompt:'Review'},{preloadFiles})).rejects.toThrow('Tool denied'); expect(f.requests).toHaveLength(0); }
  finally { await f.close(); }
});
test('aggregate source limit cannot be increased with rendered ranges', async () => {
  const f=await fixture();
  try {
    const files=['one.txt','two.txt','three.txt'];
    for(const name of files) await writeFile(f.root+'/'+name,'small first line\n'+'x'.repeat(900_000));
    await expect(runHarnessTask(f.harness,{prompt:'Review'},{preloadFiles:{files:files.map(path=>({path,startLine:1,endLine:1})),maxBytes:64000}})).rejects.toThrow('aggregate');
    expect(f.requests).toHaveLength(0);
  } finally {await f.close();}
});
test('each new explicit invocation reads current content, not a persistent cache', async()=>{
  const f=await fixture();
  try{
    await runHarnessTask(f.harness,{prompt:'Review'},{preloadFiles});
    await writeFile(f.root+'/src/file.ts','export const marker="UPDATED_CONTENT";');
    await runHarnessTask(f.harness,{prompt:'Review again'},{preloadFiles});
    expect(f.requests[0]).toContain('SNAPSHOT_CONTENT');expect(f.requests[1]).toContain('UPDATED_CONTENT');expect(f.requests[1]).not.toContain('SNAPSHOT_CONTENT');
  }finally{await f.close();}
});
test('execution and approval overrides never fall back to host reads', async()=>{
  const f=await fixture();
  try{
    await expect(runHarnessTask(f.harness,{prompt:'Review',toolApprovalPolicy:()=>true},{preloadFiles})).rejects.toThrow('PRELOAD_UNSUPPORTED');
    await expect(runHarnessTask(f.harness,{prompt:'Review',executionEnvironment:{} as any},{preloadFiles})).rejects.toThrow('PRELOAD_UNSUPPORTED');
    const tool=(f.harness.agent.tools as any).read_files;
    tool.isEnabled=()=>false;
    await expect(runHarnessTask(f.harness,{prompt:'Review'},{preloadFiles})).rejects.toThrow('PRELOAD_REQUIRES');
    expect(f.requests).toHaveLength(0);
  }finally{await f.close();}
});
