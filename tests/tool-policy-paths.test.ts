import { expect, test } from 'bun:test';
import { builtinToolPolicyPathResolver, validateBuiltinToolPolicy } from '../src/runtime/tool-policy-paths.js';
import { createHarnessToolPolicy, type HarnessToolPolicy } from '../src/runtime/tool-policy.js';

const rule = (tools: string[]): HarnessToolPolicy => ({ schemaVersion: 1, rules: [{ id: 'protected', tools, paths: ['private.txt'], decision: 'deny', reason: 'Protected' }] });

test('exact built-in projections include every read and both move endpoints', () => {
  const policy = rule(['read_file', 'read_files', 'move_file']);
  const resolve = builtinToolPolicyPathResolver(policy);
  validateBuiltinToolPolicy(policy, ['read_file', 'read_files', 'move_file']);
  expect(resolve('read_files', { files: [{ path: 'public.txt' }, { path: 'private.txt' }] })).toEqual(['public.txt', 'private.txt']);
  const paths = resolve('move_file', { source: 'public.txt', destination: 'private.txt', expectedDigest: `sha256:${'a'.repeat(64)}` });
  expect(paths).toEqual(['public.txt', 'private.txt']);
  expect(createHarnessToolPolicy(policy).evaluate({ toolName: 'move_file', paths }).decision).toBe('deny');
  expect(() => resolve('read_file', { path: 'src/../private.txt' })).toThrow();
  expect(resolve('unrelated', { path: '../opaque' })).toEqual([]);
});

test('exact edit projections refuse malformed multi-file input before effects', () => {
  const resolve = builtinToolPolicyPathResolver(rule(['apply_reviewed_edits']));
  expect(resolve('apply_reviewed_edits', { changes: [{ path: 'public.txt', expectedDigest: null, content: 'a' }, { path: 'private.txt', expectedDigest: null, content: 'b' }] })).toEqual(['public.txt', 'private.txt']);
  expect(() => resolve('apply_reviewed_edits', { changes: [{ path: '../private.txt', expectedDigest: null, content: 'b' }] })).toThrow();
});

test('unavailable tools and non-enumerable path-scoped tools reject at construction', () => {
  expect(() => validateBuiltinToolPolicy(rule(['absent']), ['read_file'])).toThrow('unavailable');
  for (const name of ['search_files', 'list_files', 'run_check', 'restore_file', 'constructor']) {
    expect(() => validateBuiltinToolPolicy(rule([name]), [name])).toThrow('safely resolve');
  }
  expect(() => validateBuiltinToolPolicy({ schemaVersion: 1, rules: [{ id: 'deny-checks', tools: ['run_check'], decision: 'deny', reason: 'No commands' }] }, ['run_check'])).not.toThrow();
});
