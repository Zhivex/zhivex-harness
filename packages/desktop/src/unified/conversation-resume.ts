import type {HarnessClientSession} from '@zhivex-ai/harness/protocol';

export function conversationTitle(session: HarnessClientSession) {
  const title = session.title?.trim();
  return title && title !== 'New conversation' ? title : `Chat ${session.sessionId.slice(-6)} · ${new Date(session.createdAt).toLocaleString()}`;
}
export function conversationStatus(session: HarnessClientSession) {
  const status = session.runs.at(-1)?.status;
  const labels: Record<string, string> = {waiting_approval: 'Needs review', running: 'In progress', created: 'Starting', cancel_requested: 'Stopping', completed: 'Completed', failed: 'Stopped with an error', cancelled: 'Stopped', timed_out: 'Timed out'};
  return status ? labels[status] ?? status : 'No messages yet';
}
export function findConversations(sessions: HarnessClientSession[], query: string, pendingOnly: boolean) {
  const needle = query.trim().toLocaleLowerCase();
  return sessions.filter(session => (!pendingOnly || session.runs.at(-1)?.status === 'waiting_approval') && `${conversationTitle(session)} ${conversationStatus(session)}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.sessionId.localeCompare(b.sessionId));
}
