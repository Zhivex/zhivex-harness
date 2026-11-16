import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import type {HarnessClientSession} from '@zhivex-ai/harness/protocol';
import {conversationTitle, findConversations} from '../src/unified/conversation-resume.js';
import {DecisionHistory} from '../src/unified/DecisionHistory.js';
const session = (id: string, title: string, updatedAt: number, status = 'completed') => ({sessionId: id, title, createdAt: updatedAt, updatedAt, runs: [{runId: id+'-turn', sequence: 0, createdAt: updatedAt, updatedAt, status, model: 'test'}]}) as HarnessClientSession;
test('default titles are distinguishable without copying message content', () => {
  expect(conversationTitle(session('a', 'New conversation', 1000))).not.toBe(conversationTitle(session('b', 'New conversation', 2000)));
  expect(conversationTitle(session('a', 'New conversation', 1000))).not.toBe(conversationTitle(session('b', 'New conversation', 1000)));
  expect(conversationTitle(session('a', 'Release checklist', 1000))).toBe('Release checklist');
});
test('search trims input, finds statuses, sorts recent first, and combines pending filter', () => {
  const entries = [session('a','Earlier',1000), session('b','Release',3000,'waiting_approval'), session('c','Later',2000)];
  expect(findConversations(entries,'',false).map(s=>s.sessionId)).toEqual(['b','c','a']);
  expect(findConversations(entries,'  RELEASE  ',false).map(s=>s.sessionId)).toEqual(['b']);
  expect(findConversations(entries,'needs review',false).map(s=>s.sessionId)).toEqual(['b']);
  expect(findConversations(entries,'Later',true)).toEqual([]);
  expect(findConversations(entries,'',true).map(s=>s.sessionId)).toEqual(['b']);
  expect(entries[0]!.sessionId).toBe('a');
});
test('history opens the requested older turn instead of silently choosing the latest', () => {
  const s=session('a','Release',1000); s.runs.push({...s.runs[0]!, runId:'newer',sequence:1});
  const html=renderToStaticMarkup(<DecisionHistory hostId="host" session={s} initialRunId="a-turn" onConversation={()=>{}} />);
  expect(html).toContain('value="a-turn" selected');
  expect(html).toContain('Turn 1');
  expect(html).not.toContain('Turn 0');
  expect(html).toContain('View this turn in conversation');
});
