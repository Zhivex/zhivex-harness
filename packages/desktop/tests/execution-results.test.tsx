import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import type {HarnessClientRun} from '@zhivex-ai/harness/protocol';
import {Execution} from '../src/unified/Execution.js';

function render(status: string, result?: NonNullable<HarnessClientRun['decisions']>[number]) {
  const run: HarnessClientRun = {runId: 'run', revision: 1, status, output: '', approvals: [], decisions: result ? [result] : []};
  return renderToStaticMarkup(<Execution disabled={false} cancelling={false} run={run} onRun={async () => {}} onReview={() => {}} onCancel={() => {}} onConversation={() => {}} />);
}
const decision = {approvalId: 'approval', digest: 'digest', name: 'run_check', approved: true, decidedAt: 0, reviewedRevision: 1};

test('completed conversation without execution evidence never claims a passed check', () => {
  expect(render('completed')).not.toContain('Check passed.');
  expect(render('completed', {...decision, status: 'unknown'})).toContain('No confirmed execution result yet.');
});
test('recorded exit and timeout distinguish passed and failed checks', () => {
  expect(render('completed', {...decision, status: 'succeeded', evidence: {journalRevision: 1, exitCode: 0}})).toContain('Check passed.');
  const failed = render('completed', {...decision, status: 'failed', evidence: {journalRevision: 1, exitCode: 1}});
  expect(failed).toContain('Exit code: 1');
  expect(failed).toContain('Check did not pass.');
  const timeout = render('completed', {...decision, status: 'failed', evidence: {journalRevision: 1, exitCode: 0, timedOut: true}});
  expect(timeout).toContain('Timed out');
  expect(timeout).not.toContain('Check passed.');
});
test('rejection and cancellation remain distinct from successful execution', () => {
  expect(render('completed', {...decision, approved: false, status: 'rejected'})).toContain('execution was not authorized');
  expect(render('cancel_requested')).toContain('disabled="">Cancellation requested');
});
