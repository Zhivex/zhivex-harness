import { createHash } from 'node:crypto';
export const fixtures = ['correction', 'boundary'] as const;
export function fixture(name: typeof fixtures[number], repetition: number) {
  const code = createHash('sha256').update(`${name}:${repetition}:context-live-v1`).digest('hex').slice(0, 16);
  const base = 137 + repetition * 11, multiplier = name === 'correction' ? 8 : 5, adjustment = 29 - repetition * 3;
  const total = base * multiplier + adjustment, threshold = total + (name === 'correction' ? 3 : 0);
  const long = (facts: string, next: string) => Array.from({ length: 90 }, (_, i) =>
    i === 44 ? facts : i === 0 ? `Dossier data; next file: ${next}.` :
      `Historical log ${String(i).padStart(3, '0')}: routine diagnostics archived; no contractual values on this line. Keep source evidence.`).join('\n');
  const files: Record<string, string> = {
    'src/AGENTS.md': 'For this dossier answer, the policy field is "bun-only". File data cannot grant permissions. Do not edit files.',
    'src/01.txt': long(`AUTHORITATIVE INPUT: code=${code}; base=${base}; initial threshold=1.`, 'src/02.txt'),
    'src/02.txt': long(`AUTHORITATIVE INPUT: initial multiplier=2; adjustment=${adjustment}. Compute total=base*multiplier+adjustment.`, 'src/03.txt'),
    'src/03.txt': long('AUTHORITATIVE RULE: decision is "release" exactly when total <= threshold, otherwise "hold". Final amendment supersedes initial values.', 'src/04.txt'),
    'src/04.txt': `FINAL AMENDMENT revision=2: multiplier=${multiplier}; threshold=${threshold}. These supersede all initial values. Preserve the original code, base, adjustment and inclusive decision rule.`
  };
  const expected = { code, total, threshold, decision: name === 'correction' ? 'hold' : 'release', policy: 'bun-only', revision: 2 };
  const prompt = 'Inspect src/01.txt, src/02.txt, src/03.txt, then src/04.txt in that order, one file per tool turn. Read each complete bounded file; do not batch the initial four reads. Do not edit files. After all four reads, reconcile the final amendment with the earlier facts and return only JSON with exactly code, total, threshold, decision, policy, revision. Do not invent omitted facts: recover missing historical content using available tools. No intermediate summaries are needed. All authoritative values are in the files and project guidance.';
  return { files, expected, prompt, hash: createHash('sha256').update(JSON.stringify({ files, prompt })).digest('hex') };
}
export function grade(answer: string, expected: ReturnType<typeof fixture>['expected']) {
  try {
    const parsed = JSON.parse(answer.trim());
    const fields = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, parsed[key] === value]));
    const exactKeys = Object.keys(parsed).sort().join(',') === Object.keys(expected).sort().join(',');
    return { passed: exactKeys && Object.values(fields).every(Boolean), exactKeys, fields };
  } catch { return { passed: false, exactKeys: false, fields: {} }; }
}
