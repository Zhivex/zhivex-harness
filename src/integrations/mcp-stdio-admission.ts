import { createHash } from 'node:crypto';
import { z } from 'zod';

const name = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeString = z.string().max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const relativeDirectory = z.string().max(1024).refine(value => value === '.' ||
  (value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !/[\x00-\x1f\x7f]/.test(value)));
const proposalSchema = z.object({
  schemaVersion: z.literal(1),
  serverId: name.max(64),
  boundary: z.literal('oci'),
  image: z.string().max(512).regex(/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  executable: safeString.refine(value => value.startsWith('/') && !value.includes('\\') &&
    value.split('/').slice(1).every(part => part !== '' && part !== '.' && part !== '..')),
  args: z.array(safeString).max(128),
  protocolVersion: z.literal('2025-11-25'),
  workingDirectory: relativeDirectory,
  snapshotDigest: digest,
  scope: z.object({ principal: name, tenant: name, session: name, workspace: digest }).strict(),
  includeTools: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)).min(1).max(200),
  permissions: z.array(z.enum(['read', 'write'])).min(1).max(2),
  environment: z.record(z.string().regex(/^ZHIVEX_MCP_[A-Z0-9_]{1,96}$/), safeString)
    .refine(value => Object.keys(value).length <= 64 && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32 * 1024).default({}),
  secretReferences: z.record(z.string().regex(/^ZHIVEX_MCP_[A-Z0-9_]{1,96}$/), name)
    .refine(value => Object.keys(value).length <= 32).default({}),
  limits: z.object({
    sessionMs: z.number().int().min(100).max(600_000),
    callMs: z.number().int().min(100).max(60_000),
    memoryMb: z.number().int().min(16).max(2048),
    maxCpus: z.number().min(0.1).max(8).multipleOf(0.1),
    maxPids: z.number().int().min(1).max(128),
    maxWorkspaceBytes: z.number().int().min(1024).max(512 * 1024 * 1024),
    maxFileWriteBytes: z.number().int().min(1).max(64 * 1024 * 1024),
    tmpfsMb: z.number().int().min(1).max(256),
    maxOutputBytes: z.number().int().min(1024).max(4 * 1024 * 1024)
  }).strict()
}).strict().superRefine((value, context) => {
  if (Object.keys(value.environment).some(key => key in value.secretReferences)) {
    context.addIssue({ code: 'custom', message: 'Environment and secret names overlap' });
  }
  if (value.limits.callMs > value.limits.sessionMs) context.addIssue({ code: 'custom', message: 'Call limit exceeds session limit' });
  if (value.limits.maxFileWriteBytes > value.limits.maxWorkspaceBytes) context.addIssue({ code: 'custom', message: 'Write limit exceeds workspace limit' });
});
export type McpStdioLaunchProposal = z.infer<typeof proposalSchema>;
export type McpStdioLaunchReceipt = Readonly<Record<never, never>>;

export class McpStdioAdmissionError extends Error {
  constructor(message: string) { super(message); this.name = 'McpStdioAdmissionError'; }
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = (proposal: McpStdioLaunchProposal) => createHash('sha256').update(canonical(proposal)).digest('hex');
function normalize(input: unknown): McpStdioLaunchProposal {
  const parsed = proposalSchema.safeParse(input);
  // Do not echo configuration values or secret reference names in diagnostics.
  if (!parsed.success) throw new McpStdioAdmissionError('Invalid isolated MCP launch proposal.');
  return parsed.data;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Owned by the trusted host, never constructed from client/workspace configuration. */
export function createMcpStdioAdmissionAuthority(options: {
  policyVersion: string;
  maximumLimits: McpStdioLaunchProposal['limits'];
  authorize: (proposal: Readonly<McpStdioLaunchProposal>) => Promise<boolean>;
  receiptTtlMs?: number;
  reviewTimeoutMs?: number;
  now?: () => number;
}) {
  const limits = proposalSchema.shape.limits.parse(options.maximumLimits);
  if (!options.policyVersion || typeof options.authorize !== 'function') throw new McpStdioAdmissionError('Host admission policy is required.');
  const policyVersion = options.policyVersion;
  const authorize = options.authorize;
  const ttl = options.receiptTtlMs ?? 30_000;
  const timeoutMs = options.reviewTimeoutMs ?? 30_000;
  if (![ttl, timeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 60_000)) {
    throw new McpStdioAdmissionError('Invalid admission deadline.');
  }
  const now = options.now ?? (() => performance.now());
  const receipts = new WeakMap<object, { fingerprint: string; expires: number; policy: string }>();
  const checked = (input: unknown) => {
    const proposal = normalize(input);
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      if (proposal.limits[key] > limits[key]) throw new McpStdioAdmissionError('MCP launch exceeds host policy limits.');
    }
    return proposal;
  };
  return {
    async admit(input: unknown): Promise<McpStdioLaunchReceipt> {
      const proposal = freeze(checked(input));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let approved: boolean;
      try {
        approved = await Promise.race([
          Promise.resolve().then(() => authorize(proposal)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new McpStdioAdmissionError('MCP host admission timed out.')), timeoutMs); })
        ]);
      } catch (error) {
        if (error instanceof McpStdioAdmissionError) throw error;
        throw new McpStdioAdmissionError('MCP host admission failed.');
      } finally { if (timer !== undefined) clearTimeout(timer); }
      if (approved !== true) throw new McpStdioAdmissionError('MCP launch was not admitted by the host.');
      const receipt = Object.freeze(Object.create(null)) as McpStdioLaunchReceipt;
      receipts.set(receipt, { fingerprint: fingerprint(proposal), expires: now() + ttl, policy: policyVersion });
      return receipt;
    },
    consume(receipt: McpStdioLaunchReceipt, input: unknown): Readonly<McpStdioLaunchProposal> {
      const stored = receipt && typeof receipt === 'object' ? receipts.get(receipt) : undefined;
      if (!stored) throw new McpStdioAdmissionError('Unknown or already consumed MCP admission.');
      // Burn before validation: even failed launch attempts cannot reuse authority.
      receipts.delete(receipt);
      const proposal = checked(input);
      if (stored.expires <= now() || stored.policy !== policyVersion || stored.fingerprint !== fingerprint(proposal)) {
        throw new McpStdioAdmissionError('MCP admission expired or launch identity changed.');
      }
      return freeze(proposal);
    }
  };
}
