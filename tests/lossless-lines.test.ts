import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeLosslessLines, decodeLosslessLines } from '../packages/core/src/context/lossless-lines.js';
import { fixture, fixtures } from '../scripts/benchmarks/context-live/fixtures.js';
test('lossless encoding preserves all middle facts, boundaries, Unicode and newline variants', () => {
  for (const name of fixtures) for (const content of Object.values(fixture(name, 7).files)) {
    const encoded = encodeLosslessLines(content);
    expect(encoded ? decodeLosslessLines(encoded) : content).toBe(content);
  }
  for (const ending of ['', '\n', '\r\n']) for (let seed = 0; seed < 40; seed++) {
    const content = Array.from({length:100}, (_, i) => i === seed ? `UNIQUE ${seed} 😀 \u0000` : `${i}💡${'abc😀'.repeat(40)}\r`).join('\n') + ending;
    const encoded = encodeLosslessLines(content);
    expect(encoded).toBeDefined();
    expect(decodeLosslessLines(encoded!)).toBe(content);
  }
});
test('incompressible content stays raw, including long single lines', () => {
  for (const content of ['', 'single', 'x'.repeat(20000), Array.from({length:300}, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('\n')])
    expect(encodeLosslessLines(content)).toBeUndefined();
});
