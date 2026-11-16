import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { rendererString } from '../src/renderer-script.js';

test('renderer literals preserve hostile data without executing it or terminating script markup', () => {
  for (const value of [
    `</script><script>globalThis.executed=true</script>`,
    `"');globalThis.executed=true;//`,
    `\\\n\r\t\0\u2028\u2029<&>`,
    'session-123'
  ]) {
    const literal = rendererString(value);
    expect(literal).not.toMatch(/[<>&\u2028\u2029]/);
    const context = { executed: false };
    expect(runInNewContext(`(${literal})`, context)).toBe(value);
    expect(context.executed).toBe(false);
  }
});
