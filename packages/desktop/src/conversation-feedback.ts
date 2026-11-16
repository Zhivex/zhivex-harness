import type { HarnessClientRun, HarnessActivityRun } from '@zhivex-ai/harness/protocol';
import type { TicketedApprovalReview } from '@zhivex-ai/harness/application';

export function actionLabel(name: string) {
  const labels: Record<string, string> = { apply_reviewed_replacement: 'Edit file', run_check: 'Run check', read_file: 'Read file', list_files: 'List files', search_files: 'Search files' };
  return labels[name] ?? name.replaceAll('_', ' ');
}

export function actionStatus(tool: NonNullable<HarnessActivityRun['tools']>[string], status: string, decision?: NonNullable<HarnessClientRun['decisions']>[number]) {
  if (decision?.status === 'rejected') return 'Rejected';
  if (decision?.status === 'failed') return 'Failed';
  if (tool.status === 'failed' || tool.timedOut || (tool.exitCode !== undefined && tool.exitCode !== 0)) return 'Failed';
  if (tool.status === 'completed') return tool.name === 'run_check' && tool.exitCode === undefined ? 'No result evidence' : 'Completed';
  if (decision?.status === 'applied' || decision?.status === 'succeeded') return 'Completed';
  if (status === 'waiting_approval') return 'Paused for review';
  if (!['running', 'created', 'queued'].includes(status)) return 'No confirmed result';
  return decision?.approved ? 'Approved · awaiting result' : 'Running';
}

/** A failed transport/command response is not proof that a decision was lost. Never replay it. */
export function decisionRecorded(review: TicketedApprovalReview, run: HarnessClientRun, approved: boolean) {
  return run.runId === review.runId && run.revision > review.revision && review.items.length > 0 && review.items.every(item =>
    run.decisions?.some(decision => decision.approvalId === item.approvalId && decision.digest === item.digest && decision.reviewedRevision === review.revision && decision.approved === approved));
}

export function failureHint(error?: HarnessClientRun['error']) {
  switch (error?.category) {
    case 'provider': return 'The model could not return a response. Check your model connection before trying again.';
    case 'configuration': return 'Check your model configuration before trying again.';
    case 'workspace': return 'The workspace could not be accessed. Check that it is available, then refresh.';
    case 'approval': return 'The action could not proceed with its approval. Check the saved decisions before continuing.';
    case 'state': return 'The conversation changed while the task was running. Refresh to inspect the saved state.';
    default: return 'The task stopped before completion. Check the action results and saved decisions before continuing.';
  }
}
