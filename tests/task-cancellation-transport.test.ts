import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { wrapLanguageModel } from '@zhivex-ai/core';
import { createMockLanguageModel } from '@zhivex-ai/agents/testing';
import { resolveHarnessConfig } from '../src/runtime/config.js';
import { openHarnessPersistence } from '../src/persistence/operations.js';
import { TaskBudget } from '../src/runtime/task-budget.js';
import { createCheckpointTokenCap } from '../src/runtime/runtime-policy.js';
import { UsageLedger } from '../src/runtime/usage-ledger.js';

const limits = { inputTokens: 10000, outputTokens: 1000, totalTokens: 11000 };
for (const route of ['generate', 'stream'] as const)
for (const boundary of ['usage', 'additionalUsage'] as const)
test(`durable cancellation fences ${route} after inner checkpoint cap ${boundary}`, async () => {
  const root = await mkdtemp('/tmp/hu71-transport-boundary-');
  const config = resolveHarnessConfig({ workspace: root, storeBackend: 'sqlite', subagentProfiles: [] });
  const persistence = await openHarnessPersistence(config);
  const ledger = await UsageLedger.open(config, {});
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<unknown> | undefined;
  try {
    const account = await TaskBudget.open({ store: persistence.store, scope: config.scope,
      taskId: `${route}-${boundary}`, policy: { limits } });
    let requests = 0;
    const model = createMockLanguageModel();
    model.generate = async () => { requests++; throw new Error('transport must not be called'); };
    model.stream = async () => { requests++; throw new Error('transport must not be called'); };
    const pause = async () => { entered(); await gate; };
    const cap = createCheckpointTokenCap(config.budget, async () => {
      if (boundary === 'usage') await pause();
      return undefined;
    }, true, { additionalUsage: async () => {
      if (boundary === 'additionalUsage') await pause();
      return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    } });
    // Match the host's nesting: task authority outside checkpoint accounting,
    // then the innermost monetary admission and provider transport.
    const wrapped = wrapLanguageModel(wrapLanguageModel(ledger.model(model), [cap]), [account.middleware()]);
    pending = account.run('r', () => ledger.run(account.accountRunId, async () => {
      const input = { messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'fixture' }] }] };
      if (route === 'generate') await wrapped.generate(input);
      else for await (const _event of await wrapped.stream!(input)) { /* drain */ }
    }));
    pending.catch(() => {});
    await ready;
    await account.requestCancellation('r');
    release();
    await expect(pending).rejects.toThrow();
    expect(requests).toBe(0);
    expect(ledger.summary(account.accountRunId).calls).toBe(0);
    expect(await account.summary()).toMatchObject({ usageComplete: true, remaining: limits,
      confirmed: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, admissionsClosed: true });
  } finally {
    release();
    await pending?.catch(() => {});
    ledger.close(); persistence.close();
    await rm(root, { recursive: true, force: true });
  }
});
