import type {AutomationSnapshot, AutomationChange} from './contracts.js';
export type {AutomationSnapshot, AutomationChange} from './contracts.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {connectApplication} from './client.js';
import type {ManagedApplication} from './coordinator-client.js';
import {validZone} from './assistant/automation/time.js';

const stateSchema = z.object({
  schedule: z.object({enabled: z.number().int().min(0).max(1), revision: z.number().int(), next_at: z.number()}).nullable(),
  preferences: z.array(z.object({key: z.string(), value: z.string()})),
  occurrences: z.array(z.object({id: z.string(), day: z.string(), status: z.string(), attempts: z.number().int()})),
});
const changeSchema = z.object({action: z.enum(['configure', 'pause', 'resume', 'delete', 'forget']), expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), confirmed: z.literal(true), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(), timeZone: z.string().refine(validZone).optional()}).strict();
/** Configuration lane only; never executes a summary or retries an external delivery. */
export async function applicationAutomation(manager: ManagedApplication, raw: unknown): Promise<AutomationSnapshot> {
  const input = z.object({projectId: z.string().min(1), change: changeSchema.optional()}).strict().parse(raw);
  const host = manager.currentHost(); if (!host) throw new Error('ASSISTANT_UNAVAILABLE');
  if ((await connectApplication(host.credentialsPath)).projectId !== input.projectId) throw new Error('APPLICATION_SCOPE_CHANGED');
  const snapshot = (): AutomationSnapshot => {
    const state = host.automation ? stateSchema.parse(host.automation.status()) : null;
    const linked = Boolean(host.diagnostics().telegram?.linked);
    const digest = 'sha256:' + createHash('sha256').update(JSON.stringify({projectId: input.projectId, linked, schedule: state?.schedule, preferences: state?.preferences})).digest('hex');
    return {available: Boolean(state), linked, delivery: 'telegram', digest, state};
  };
  const before = snapshot(), change = input.change;
  if (!change) return before;
  if (!host.automation) throw new Error('AUTOMATION_UNAVAILABLE');
  if (change.expectedDigest !== before.digest) throw new Error('AUTOMATION_REVIEW_STALE');
  if (['configure', 'resume'].includes(change.action) && !before.linked) throw new Error('AUTOMATION_TELEGRAM_REQUIRED');
  if (change.action !== 'configure' && (change.localTime || change.timeZone)) throw new Error('AUTOMATION_ARGUMENTS_INVALID');
  let command: string;
  if (change.action === 'configure') {
    if (!change.localTime || !change.timeZone) throw new Error('AUTOMATION_PREFERENCES_REQUIRED');
    command = `/daily ${change.localTime} ${change.timeZone}`;
  } else command = change.action === 'forget' ? '/memory forget all' : `/daily ${change.action}`;
  host.automation.command(command);
  const after = snapshot();
  if (['configure', 'resume'].includes(change.action) && !after.state?.schedule?.enabled) throw new Error('AUTOMATION_PREFERENCES_REQUIRED');
  return after;
}
