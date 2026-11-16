import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { connectApplication } from '../client.js';
import type { HarnessLocalService } from '../../client/local-service.js';
import { openGitDelivery } from './git-delivery.js';
import { openRemoteDelivery } from './remote-delivery.js';
import { openPullRequestDelivery } from './pr-delivery.js';
import { openGitHubGitTransport } from './github-git-transport.js';
import { openGitHubPullRequestTransport } from './github-pr-transport.js';

/** Core-owned Git authority; clients receive previews and opaque receipts, never shell commands. */
export function createCodeDelivery(service: HarnessLocalService, workspace: string, directory: string, secrets: readonly string[]) {
  const root = path.join(directory, 'delivery', createHash('sha256').update(workspace).digest('hex').slice(0, 24));
  let local: ReturnType<typeof openGitDelivery> | undefined;
  let transport: ReturnType<typeof openGitHubGitTransport> | undefined;
  let remote: ReturnType<typeof openRemoteDelivery> | undefined, pr: ReturnType<typeof openPullRequestDelivery> | undefined;
  const git = () => local ??= openGitDelivery(workspace, path.join(root, 'commit'), secrets).catch(error => {local = undefined; throw error;});
  const connection = () => transport ??= openGitHubGitTransport(workspace).catch(error => {transport = undefined; throw error;});
  const push = async () => remote ??= connection().then(value => openRemoteDelivery(path.join(root, 'push'), value, secrets)).catch(error => {remote = undefined; throw error;});
  const pullRequest = async () => pr ??= connection().then(value => openPullRequestDelivery(path.join(root, 'pr'), openGitHubPullRequestTransport(value), secrets)).catch(error => {pr = undefined; throw error;});
  let queue = Promise.resolve();
  const exclusive = async <T>(operation: () => Promise<T>) => {
    try {
      if (service.pauseAdmission()) throw new Error('GIT_RUNTIME_BUSY');
      const client = await connectApplication(service.credentialsPath);
      const result = await client.command({method: 'session.list'});
      if (!result.ok || result.data.kind !== 'sessions' || result.data.sessions.some(session => session.runs.some(run => !['completed', 'failed', 'cancelled', 'timed_out'].includes(run.status)))) throw new Error('GIT_RUNTIME_BUSY');
      return await operation();
    } finally { service.resumeAdmission(); }
  };
  const dispatch = async (action: string, input: unknown): Promise<unknown> => {
    switch(action) {
      case 'changes': return (await git()).changes();
      case 'stage': return exclusive(async () => (await git()).stage(input));
      case 'review-commit': return exclusive(async () => (await git()).reviewCommit(input));
      case 'commit': return exclusive(async () => (await git()).commit(z.string().uuid().parse(input)));
      case 'reconcile-commit': return (await git()).reconcile(z.string().uuid().parse(input));
      case 'targets': return (await connection()).targets();
      case 'review-push': return exclusive(async () => (await push()).reviewPush(input));
      case 'push': return exclusive(async () => (await push()).push(z.string().uuid().parse(input)));
      case 'reconcile-push': return (await push()).reconcile(z.string().uuid().parse(input));
      case 'review-pr': return exclusive(async () => (await pullRequest()).review(input));
      case 'create-pr': return exclusive(async () => (await pullRequest()).create(z.string().uuid().parse(input)));
      case 'reconcile-pr': return (await pullRequest()).reconcile(z.string().uuid().parse(input));
      case 'open-pr': {
        const result = await (await pullRequest()).reconcile(z.string().uuid().parse(input));
        if (result.status === 'not-accepted' || !result.result) throw new Error('PR_NOT_CONFIRMED');
        return result.result.url;
      }
      default: throw new Error('GIT_ACTION_INVALID');
    }
  };
  return {
    call(action: string, input?: unknown) { const pending = queue.then(() => dispatch(action, input)); queue = pending.then(() => {}, () => {}); return pending; },
    async close() { await queue; if (transport) await (await transport).close(); },
  };
}
