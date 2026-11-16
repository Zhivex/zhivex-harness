import type {NotesSnapshot} from './contracts.js';
export type {NotesSnapshot} from './contracts.js';
import {z} from 'zod';
import type {ManagedApplication} from './coordinator-client.js';
import {connectApplication} from './client.js';
const summary = z.object({id: z.string().uuid(), title: z.string(), created_at: z.number()});
const note = summary.extend({body: z.string()});
/** Reads only: writing and deleting notes require the runtime's reviewed tools. */
export async function readNotes(manager: ManagedApplication, raw: unknown): Promise<NotesSnapshot> {
  const input = z.object({projectId: z.string().min(1), query: z.string().trim().max(200).default(''), offset: z.number().int().min(0).max(10000).default(0), noteId: z.string().uuid().optional()}).strict().parse(raw);
  const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
  const client = await connectApplication(host.credentialsPath);
  if (client.projectId !== input.projectId || manager.currentHost() !== host) throw new Error('APPLICATION_SCOPE_CHANGED');
  if (!host.daily) return {enabled: false, notes: [], total: 0, nextOffset: null};
  const page = input.query ? host.daily.searchNotes({query: input.query, offset: input.offset, limit: 20}) : host.daily.listNotes({offset: input.offset, limit: 20});
  return {enabled: true, notes: z.array(summary).parse(page.notes), total: page.total, nextOffset: page.nextOffset, ...(input.noteId ? {note: note.parse(host.daily.readNote({noteId: input.noteId}))} : {})};
}
