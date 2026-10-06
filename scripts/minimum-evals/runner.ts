import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import type { JsonValue, StreamEvent } from '@zhivex-ai/core';
import { runPortableProcess } from '../../src/execution/process-runtime.js';
import { agentFixture, digest, TASK_BUDGET, SYNTHETIC_MODEL_SETTINGS, type MinimumFixture } from './protocol.js';

type Engine = typeof import('../../src/engine/index.js');
export interface MinimumAttempt {
  fixtureId: string; variant: string; repetition: number; attempt: number; mode: 'reference' | 'empty';
  runCompleted: boolean; initialPublicCheckFailed: boolean; oraclePassed: boolean; publicCheckPassed: boolean; scopePassed: boolean; protectedFilesUnchanged: boolean;
  automatedPass: boolean; acceptedChange: null; humanReview: { status: 'pending'; blindReviewId: string; minutes: null; interventions: null };
  failureClass: 'none' | 'runtime' | 'oracle' | 'scope' | 'infrastructure' | 'budget'; restarted: boolean;
  modelSettings: typeof SYNTHETIC_MODEL_SETTINGS; budget: typeof TASK_BUDGET; budgetScope: 'task';
  usage: { inputTokens: number | null; outputTokens: number | null; complete: boolean; costUsd: null; kind: 'synthetic-not-billable' };
  latency: { wallMs: number; activeMs: number; humanMinutes: null }; calls: number; compactions: number; tools: number; bytesWritten: number; repeatedWork: null;
  patch: Record<string, string>; patchSha256: string; diagnostics: string[];
}
async function writeTree(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
}
async function snapshot(root: string, relative = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && ['.zhivex-harness', '.git'].includes(entry.name)) continue;
    const name = relative ? relative + '/' + entry.name : entry.name;
    const stat = await lstat(path.join(root, name));
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error('MINIMUM_UNSAFE_SUBMISSION');
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, name));
    else if (entry.isFile() && stat.size <= 100_000) result[name] = await readFile(path.join(root, name), 'utf8');
    else throw new Error('MINIMUM_UNSAFE_SUBMISSION');
  }
  return result;
}
const check = (root: string, filename: string) => runPortableProcess(['bun', '--no-env-file', filename], { cwd: root, timeoutMs: 10_000 });

/** Hidden oracle executes in a clean grader checkout after the agent has closed. */
export async function gradeMinimumSubmission(fixture: MinimumFixture, workspace: string, grader: string) {
  const original: Record<string, string> = agentFixture(fixture).files;
  const submitted = await snapshot(workspace);
  const changed = [...new Set([...Object.keys(original), ...Object.keys(submitted)])].filter(name => original[name] !== submitted[name]);
  const scopePassed = changed.every(name => fixture.editable.includes(name));
  const protectedFilesUnchanged = Object.entries(original).every(([name, bytes]) => fixture.editable.includes(name) || submitted[name] === bytes);
  const patch: Record<string, string> = {};
  for (const name of fixture.editable) if (name in submitted && submitted[name] !== original[name]) patch[name] = submitted[name]!;
  await writeTree(grader, { ...original, ...patch, 'hidden-acceptance.ts': fixture.oracle });
  const publicCheckPassed = (await check(grader, 'public-check.ts')).exitCode === 0;
  const oraclePassed = (await check(grader, 'hidden-acceptance.ts')).exitCode === 0;
  return { scopePassed, protectedFilesUnchanged, publicCheckPassed, oraclePassed, patch, patchSha256: digest(JSON.stringify(patch)) };
}

export async function validateMinimumFixture(fixture: MinimumFixture) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'har-minimum-validate-'));
  try {
    const workspace = path.join(root, 'workspace'); await writeTree(workspace, agentFixture(fixture).files);
    const empty = await gradeMinimumSubmission(fixture, workspace, path.join(root, 'empty-grader'));
    assert(!empty.oraclePassed && !empty.publicCheckPassed, fixture.id + ': empty patch must fail both checks');
    await writeTree(workspace, fixture.reference);
    const reference = await gradeMinimumSubmission(fixture, workspace, path.join(root, 'reference-grader'));
    assert(reference.oraclePassed && reference.publicCheckPassed && reference.scopePassed && reference.protectedFilesUnchanged, fixture.id + ': reference must pass');
    return { fixtureId: fixture.id, emptyPassed: empty.oraclePassed, referencePassed: reference.oraclePassed };
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function runMinimumAttempt(api: Engine, fixture: MinimumFixture, variant: string, mode: 'reference' | 'empty' = 'reference'): Promise<MinimumAttempt> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'har-minimum-offline-'));
  const workspace = path.join(root, 'agent'), grader = path.join(root, 'protected-grader');
  const started = performance.now();
  const row: MinimumAttempt = { fixtureId: fixture.id, variant, repetition: 1, attempt: 1, mode, runCompleted: false, initialPublicCheckFailed: false, oraclePassed: false, publicCheckPassed: false, scopePassed: false, protectedFilesUnchanged: false, automatedPass: false, acceptedChange: null,
    humanReview: { status: 'pending', blindReviewId: randomUUID(), minutes: null, interventions: null }, failureClass: 'infrastructure', restarted: false,
    modelSettings: SYNTHETIC_MODEL_SETTINGS, budget: TASK_BUDGET, budgetScope: 'task', usage: { inputTokens: null, outputTokens: null, complete: false, costUsd: null, kind: 'synthetic-not-billable' }, latency: { wallMs: 0, activeMs: 0, humanMinutes: null }, calls: 0, compactions: 0, tools: 0, bytesWritten: 0, repeatedWork: null, patch: {}, patchSha256: digest('{}'), diagnostics: [] };
  let harness: Awaited<ReturnType<Engine['createHarness']>> | undefined;
  try {
    const exposed = agentFixture(fixture); await writeTree(workspace, exposed.files);
    const events: StreamEvent[][] = [];
    const call = (name: string, input: JsonValue): StreamEvent[] => [{ type: 'tool-call', toolCall: { id: 'offline-' + events.length, name, input } }, { type: 'finish', finishReason: 'tool-calls' }];
    const done: StreamEvent[] = [{ type: 'text-delta', textDelta: 'Synthetic fixture execution complete; human review remains pending.' }, { type: 'finish', finishReason: 'stop' }];
    let model = createMockLanguageModel();
    const options = { workspace, modelInstance: model, projectContext: false, subagentProfiles: [], allowedChecks: ['test'], ...TASK_BUDGET };
    harness = await api.createHarness(options);
    events.push(call('run_check', { check: 'test', expectedScript: 'bun --no-env-file public-check.ts' }));
    if (mode === 'reference') {
      const changes = await Promise.all(fixture.editable.map(async name => ({ path: name, expectedDigest: (await harness!.workspace.readFile(name)).digest, content: fixture.reference[name]! })));
      events.push(call('apply_reviewed_edits', { changes }));
    }
    events.push(call('run_check', { check: 'test', expectedScript: 'bun --no-env-file public-check.ts' }), done);
    await harness.close();
    model = createMockLanguageModel({ provider: 'synthetic', modelId: 'scripted-reference-v1', streamEvents: events });
    const originalStream = model.stream!.bind(model);
    model.stream = async input => { row.calls++; return originalStream(input); };
    options.modelInstance = model; harness = await api.createHarness(options);
    const approve: NonNullable<Parameters<Engine['runHarness']>[2]>['resolveApprovals'] = async approvals => approvals.map(item => {
      const args = JSON.parse(item.arguments);
      assert(item.name === 'run_check' && args.check === 'test' && args.expectedScript === 'bun --no-env-file public-check.ts' || item.name === 'apply_reviewed_edits' && args.changes.every((change: { path: string }) => fixture.editable.includes(change.path)), 'MINIMUM_APPROVAL_POLICY');
      return { approvalRequestId: item.id, provider: item.provider, approve: true, reason: 'Frozen synthetic policy; no human review claimed.' };
    });
    let result = await api.runHarness(harness, { prompt: exposed.instructions, abortSignal: AbortSignal.timeout(TASK_BUDGET.timeoutMs) }, { taskAcceptance: exposed.acceptance });
    if (fixture.mode === 'restart') {
      assert.equal(result.status, 'waiting_approval'); const runId = result.state.runId;
      await harness.close(); harness = await api.createHarness(options); const state = await harness.store.load(runId, harness.config.scope); assert(state);
      result = { ...result, state }; row.restarted = true;
    }
    while (result.status === 'waiting_approval') result = await api.runHarness(harness, { state: result.state, approvals: [...(await approve!(result.state.pendingApprovals, result.state) ?? [])], abortSignal: AbortSignal.timeout(Math.max(1, TASK_BUDGET.timeoutMs - (performance.now() - started))) }, { resolveApprovals: approve });
    const firstCheck = result.state.toolResults.find(tool => tool.toolName === 'run_check');
    row.initialPublicCheckFailed = Boolean(firstCheck?.output && typeof firstCheck.output === 'object' && 'exitCode' in firstCheck.output && firstCheck.output.exitCode !== 0);
    row.runCompleted = result.status === 'completed'; row.compactions = result.state.compactions?.length ?? 0; row.tools = result.state.toolResults.length;

    const usage = result.usage; row.usage.inputTokens = usage?.inputTokens ?? null; row.usage.outputTokens = usage?.outputTokens ?? null;
    // Mock totals are runtime observations; absence of provider usage stays unknown.
    row.usage.complete = row.usage.inputTokens !== null && row.usage.outputTokens !== null;
    await harness.close(); harness = undefined;
    Object.assign(row, await gradeMinimumSubmission(fixture, workspace, grader));
    row.bytesWritten = Object.values(row.patch).reduce((n, content) => n + Buffer.byteLength(content), 0);
    row.automatedPass = row.initialPublicCheckFailed && row.runCompleted && row.oraclePassed && row.publicCheckPassed && row.scopePassed && row.protectedFilesUnchanged;
    row.failureClass = row.automatedPass ? 'none' : !row.scopePassed || !row.protectedFilesUnchanged ? 'scope' : !row.runCompleted ? 'runtime' : 'oracle';
  } catch (error) { row.diagnostics.push(error instanceof Error ? error.message.replace(/\/[^\s]+/g, '[path]').slice(0, 500) : 'MINIMUM_INFRASTRUCTURE_FAILURE'); }
  finally { await harness?.close(); await rm(root, { recursive: true, force: true }); row.latency.wallMs = performance.now() - started; row.latency.activeMs = row.latency.wallMs;
    if (row.latency.wallMs > TASK_BUDGET.timeoutMs) { row.automatedPass = false; row.failureClass = 'budget'; row.diagnostics.push('MINIMUM_TASK_WALL_BUDGET_EXHAUSTED'); }
  }
  return row;
}

/** Reviewer sees requirements and submitted patch, never variant/model/latency/experiment labels. */
export function blindMinimumReview(fixture: MinimumFixture, row: MinimumAttempt) {
  return { reviewId: row.humanReview.blindReviewId, fixtureId: fixture.id, instructions: fixture.instructions, constraints: fixture.constraints, rubric: fixture.rubric, patch: row.patch, checks: { publicCheckPassed: row.publicCheckPassed, oraclePassed: row.oraclePassed, scopePassed: row.scopePassed, protectedFilesUnchanged: row.protectedFilesUnchanged }, decision: null, minutes: null, interventions: null };
}
