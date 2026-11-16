import { readFile, writeFile } from 'node:fs/promises';
import { fixture, grade } from '../docs/reports/evidence/context-live-2026-11-15/driver-source/fixtures.js';
const directory = 'docs/reports/evidence/context-live-2026-11-15';
const campaign = JSON.parse(await readFile(directory + '/campaign.json', 'utf8'));
const records = campaign.records.map(({ pair, sample }: any) => {
  const original = fixture(sample.fixture, sample.repetition).expected;
  const expected = { ...original, decision: original.total <= original.threshold ? 'release' : 'hold' };
  return { pair, model: sample.model, variant: sample.variant, originalQuality: sample.quality,
    correctedExpected: expected, correctedQuality: grade(sample.answer ?? '', expected),
    completed: sample.completed, tokensKnown: sample.calls.reduce((n: number, c: any) => n + (c.usage?.totalTokens ?? 0), 0),
    unknownUsageCalls: sample.calls.filter((c: any) => !c.usage).length };
});
const audit = { reason: 'The v1 correction fixture incorrectly expected hold while its own total <= threshold rule requires release. Raw paid campaign and original grades are immutable. This separate deterministic regrade corrects that oracle only; policy failures and missing responses remain failures.', records };
await writeFile(directory + '/oracle-audit.json', JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ tasks: records.length, correctedPasses: records.filter((r: any) => r.completed && r.correctedQuality.passed).length }));
