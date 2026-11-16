import {test, expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {readNavigation, writeNavigation} from '../src/unified/navigation.js';
import {writePreference} from '../src/local-preferences.js';

test('navigation is scoped by project and area and tolerates missing or corrupt preferences', () => {
  const a = randomUUID(), b = randomUUID();
  expect(readNavigation(a, 'assistant')).toEqual({page: 'conversation', sessionId: ''});
  writeNavigation(a, 'assistant', {page: 'notes', sessionId: 'personal-session'});
  writeNavigation(a, 'code', {page: 'execution', sessionId: 'code-session'});
  writeNavigation(b, 'code', {page: 'worktrees', sessionId: 'other-session'});
  expect(readNavigation(a, 'assistant')).toEqual({page: 'notes', sessionId: 'personal-session'});
  expect(readNavigation(a, 'code')).toEqual({page: 'execution', sessionId: 'code-session'});
  expect(readNavigation(b, 'code')).toEqual({page: 'worktrees', sessionId: 'other-session'});
  for (const raw of ['{', 'null', JSON.stringify({version: 2, page: 'notes', sessionId: 'x'}), JSON.stringify({version: 1, page: 'notes', sessionId: 7})]) {
    writePreference('navigation', a, 'assistant', raw);
    expect(readNavigation(a, 'assistant')).toEqual({page: 'conversation', sessionId: ''});
  }
  writePreference('navigation', a, 'assistant', JSON.stringify({version: 1, page: 'execution', sessionId: 'x'}));
  expect(readNavigation(a, 'assistant')).toEqual({page: 'conversation', sessionId: 'x'});
});
