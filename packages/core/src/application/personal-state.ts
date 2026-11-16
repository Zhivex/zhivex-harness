import type {PersonalSnapshot} from './contracts.js';
export type {PersonalSnapshot} from './contracts.js';
import {z} from 'zod';
import type {ManagedApplication} from './coordinator-client.js';
import {connectApplication} from './client.js';
const taskSchema = z.object({id: z.string(), title: z.string(), due_date: z.string().nullable(), status: z.string(), created_at: z.number()});
const reminderSchema = z.object({id: z.string(), text: z.string(), due_at: z.number(), time_zone: z.string(), channel: z.string(), status: z.string()});
/** Read projection only. Mutations continue through the runtime's reviewed tools. */
export async function readPersonalState(manager: ManagedApplication, raw: unknown): Promise<PersonalSnapshot> {
  const input = z.object({projectId: z.string().min(1), offset: z.number().int().min(0).max(10000).default(0)}).strict().parse(raw);
  const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
  const client = await connectApplication(host.credentialsPath);
  if (client.projectId !== input.projectId) throw new Error('APPLICATION_SCOPE_CHANGED');
  if (!host.daily) return {enabled: false, tasks: [], total: 0, nextOffset: null, reminders: []};
  const page = host.daily.listTasks({offset: input.offset, limit: 20});
  const proactive = host.daily.proactive.status();
  return {proactive: {enabled: host.binding().tools.includes('daily_write_configure_proactive'), policy: proactive.policy, sources: proactive.sources, health: proactive.health,
    alerts: proactive.alerts.map(({id, kind, text, status, channel, created_at}) => ({id, kind, text, status, channel, created_at})),
    watches: proactive.watches.map(({id, title, status, due_at}) => ({id, title, status, due_at}))}, enabled: true, tasks: z.array(taskSchema).parse(page.tasks), total: page.total, nextOffset: page.nextOffset, reminders: z.array(reminderSchema).parse(host.daily.listReminders())};
}
