import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import type {HarnessClientRun} from '@zhivex-ai/harness/protocol';
import type {TicketedApprovalReview} from '@zhivex-ai/harness/application';
import {actionStatus, decisionRecorded} from '../src/conversation-feedback.js';
import {Conversation} from '../src/Conversation.js';
const tool = {name: 'apply_reviewed_replacement', status: 'running' as const};
const decision = {approvalId: 'a', digest: 'd', name: tool.name, toolCallId: 'call', approved: false, status: 'rejected' as const, decidedAt: 1, reviewedRevision: 4};
const run: HarnessClientRun = {runId: 'r', revision: 5, status: 'failed', output: '', approvals: [], decisions: [decision]};
const review = {runId: 'r', revision: 4, items: [{approvalId: 'a', digest: 'd'}]} as TicketedApprovalReview;

test('pending and terminal actions never falsely remain running', () => {
  expect(actionStatus(tool, 'waiting_approval')).toBe('Paused for review');
  expect(actionStatus(tool, 'failed')).toBe('No confirmed result');
  expect(actionStatus(tool, 'completed')).toBe('No confirmed result');
  expect(actionStatus(tool, 'failed', decision)).toBe('Rejected');
  expect(actionStatus({...tool, name: 'run_check', status: 'completed'}, 'completed')).toBe('No result evidence');
  expect(actionStatus({...tool, status: 'completed', exitCode: 0, timedOut: true}, 'completed')).toBe('Failed');
});
test('lost decision responses reconcile only the exact complete recorded batch', () => {
  expect(decisionRecorded(review, run, false)).toBe(true);
  expect(decisionRecorded(review, run, true)).toBe(false);
  expect(decisionRecorded(review, {...run, runId: 'other'}, false)).toBe(false);
  expect(decisionRecorded(review, {...run, revision: 4}, false)).toBe(false);
  expect(decisionRecorded(review, {...run, decisions: [{...decision, digest: 'changed'}]}, false)).toBe(false);
  expect(decisionRecorded(review, {...run, decisions: [{...decision, reviewedRevision: 3}]}, false)).toBe(false);
  expect(decisionRecorded({...review, items: [...review.items, {...review.items[0]!, approvalId: 'b'}]}, run, false)).toBe(false);
  expect(decisionRecorded({...review, items: []}, run, false)).toBe(false);
});
test('conversation explains failure and shows saved rejection without claiming execution', () => {
  const markup = renderToStaticMarkup(<Conversation activity={{cursor: 1, recovered: false, order: ['r'], runs: {r: {text: '', status: 'running', truncated: false, tools: {'tool:call': tool}}}}} currentRun={run} onHistory={() => {}} onRefresh={() => {}} />);
  expect(markup).toContain('Edit file');
  expect(markup).toContain('Rejected');
  expect(markup).not.toContain('>Running<');
  expect(markup).toContain('Nothing will be retried automatically');
  expect(markup).toContain('View saved decisions');
});
