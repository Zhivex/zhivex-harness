import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workspaceFilePathSchema } from '../workspace/edit-contracts.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Text must be nonblank and contain no control characters.');
const exactPath = workspaceFilePathSchema.refine(value => !/[\\*?\[\]{}\x00-\x1f\x7f]/.test(value), 'Use an exact normalized file path, without globs or controls.');
const argv = z.array(z.string().max(8192).refine(value => !value.includes('\0'), 'Arguments cannot contain NUL.')).max(256);
const command = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/).refine(value => !['sh','bash','dash','zsh','fish','cmd','cmd.exe','powershell','pwsh'].includes(value.toLowerCase()), 'Shell interpreters are not acceptance checks.');
const commonCheck = { id: identifier, command, args: argv, purpose: text(500) };
const check = z.discriminatedUnion('kind', [
  z.strictObject({ ...commonCheck, kind: z.literal('package-script'), script: identifier, expectedScript: text(8192),
    execution: z.strictObject({ backend: z.enum(['none','oci']), approval: z.literal('required') }) }),
  z.strictObject({ ...commonCheck, kind: z.literal('argv'),
    execution: z.strictObject({ backend: z.literal('oci'), approval: z.literal('required'), network: z.literal('none') }) })
]);

/** Host-authored requirements. This contract contains no successful-check or approval claims. */
export const taskAcceptanceContractSchema = z.strictObject({
  schemaVersion: z.literal(1), taskId: identifier,
  allowedWritePaths: z.array(exactPath).max(256), protectedFiles: z.array(exactPath).max(256),
  requiredChecks: z.array(check).min(1).max(32),
  humanReview: z.array(z.strictObject({ id: identifier, requirement: text(2000), status: z.literal('pending') })).max(32)
}).superRefine((contract, context) => {
  const unique = (values: string[], field: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path: [field], message: 'Duplicate entries are not permitted.' });
  };
  unique(contract.allowedWritePaths.map(p => p.toLowerCase()), 'allowedWritePaths');
  unique(contract.protectedFiles.map(p => p.toLowerCase()), 'protectedFiles');
  unique(contract.requiredChecks.map(c => c.id), 'requiredChecks');
  unique(contract.humanReview.map(c => c.id), 'humanReview');
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b+'/') || b.startsWith(a+'/');
  const writes = contract.allowedWritePaths.map(p => p.toLowerCase());
  if (writes.some((p,i) => writes.slice(i+1).some(q => overlaps(p,q)))) {
    context.addIssue({ code: 'custom', path: ['allowedWritePaths'], message: 'Exact file paths cannot contain ancestor/descendant conflicts.' });
  }
  if (writes.some(p => contract.protectedFiles.some(q => overlaps(p,q.toLowerCase())))) {
    context.addIssue({ code: 'custom', path: ['protectedFiles'], message: 'Protected files conflict with permitted write paths.' });
  }
});
export type TaskAcceptanceContract = z.infer<typeof taskAcceptanceContractSchema>;
export const MAX_TASK_ACCEPTANCE_BYTES = 64 * 1024;

/** Canonical requirements identity; array ordering of sets is irrelevant, argv ordering is significant. */
export function compileTaskAcceptanceContract(input: unknown): { digest: string; contract: TaskAcceptanceContract } {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); }
  catch { throw new Error('TASK_ACCEPTANCE_INVALID: requirements must be JSON serializable.'); }
  if (bytes > MAX_TASK_ACCEPTANCE_BYTES) throw new Error('TASK_ACCEPTANCE_TOO_LARGE: requirements exceed 64 KiB.');
  const parsed = taskAcceptanceContractSchema.safeParse(input);
  if (!parsed.success) throw new Error('TASK_ACCEPTANCE_INVALID: '+parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const sorted = <T extends { id: string }>(items: T[]) => items.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const contract: TaskAcceptanceContract = {
    schemaVersion: 1, taskId: parsed.data.taskId,
    allowedWritePaths: [...parsed.data.allowedWritePaths].sort(), protectedFiles: [...parsed.data.protectedFiles].sort(),
    requiredChecks: sorted(parsed.data.requiredChecks), humanReview: sorted(parsed.data.humanReview)
  };
  return { contract, digest: `sha256:${createHash('sha256').update(JSON.stringify(contract)).digest('hex')}` };
}
