import { z } from 'zod';
import { openGoogleConnection, createGoogleTools, mailSearchSchema, threadSchema, draftSchema, driveSearchSchema, fileSchema, type GoogleToolsOptions } from '../integrations/google.js';
import { requestId } from '../daily/service.js';
import { moduleTools, type ModuleTool } from './tools.js';
import type { AssistantModule } from './module.js';

export function createGoogleModule(options: GoogleToolsOptions): AssistantModule {
  return { id: 'google', version: '1', async open(context) {
    const connection = await openGoogleConnection(context.directory, context.ownerId, options, context.recover);
    try {
      const service = createGoogleTools(connection, options), definitions: ModuleTool[] = [];
      if (options.mail) definitions.push(
        { name: 'mail_search', description: 'Search Gmail message IDs/thread IDs. Follow nextPageToken for more results.', schema: mailSearchSchema, execute: service.searchMail },
        { name: 'mail_thread', description: 'Read the last 20 messages of an exact Gmail thread as plain text. Attachments are not loaded.', schema: threadSchema, execute: service.readThread },
        { name: 'mail_create_draft', description: 'Create an approved Gmail draft; never sends mail. Replies require the current last message ID and matching subject. An uncertain result must not be retried with a new requestId.', schema: draftSchema, write: true, execute: service.createDraft },
        { name: 'mail_draft_status', description: 'Inspect a durable draft operation receipt without sending anything.', schema: z.strictObject({ requestId }), execute: service.draftStatus }
      );
      if (options.drive) definitions.push(
        { name: 'knowledge_search', description: 'Search Drive titles/content and return source links with pagination.', schema: driveSearchSchema, execute: service.searchDrive },
        { name: 'knowledge_read', description: 'Read a Google Doc or text/Markdown/CSV file, up to 256 KiB. Returns at most 24000 characters and a truncation flag.', schema: fileSchema, execute: service.readFile }
      );
      return { ...moduleTools('google', service.binding, 'Use Gmail and Drive only for the connected account. Cite source links. Read the thread before preparing a reply. Draft approval must include all recipients, subject, body and thread. Never claim an uncertain draft succeeded or create another one to compensate.', definitions), close: connection.close,
        ...(options.mail ? { replySource: { id: 'google', binding: service.binding, read: service.readReplyThread }, summarySources: [{ id: 'mail', async read(signal: AbortSignal) {
          const page = await service.searchMail({ query: 'in:inbox is:unread' }, signal);
          const ids = [...new Set<string>(page.messages.map((m: { threadId: string }) => m.threadId))].slice(0, 5);
          const threads = await Promise.all(ids.map(threadId => service.readThread({ threadId }, signal)));
          return JSON.stringify({ source: 'Gmail inbox unread', resultSizeEstimate: page.resultSizeEstimate, shown: threads.length,
            partial: Boolean(page.nextPageToken) || page.messages.length > ids.length,
            threads: threads.map(thread => ({ url: thread.url, subject: thread.messages.at(-1)?.subject, snippet: thread.messages.at(-1)?.snippet })) });
        } }] } : {}) };
    } catch (error) { await connection.close(); throw error; }
  } };
}
