import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentRunState, AgentRunStore, AgentStoreScope, AgentToolCallJournalEntry } from "@zhivex-ai/core";
import { createRedactionPolicy } from "@zhivex-ai/agents";
import { APPROVAL_HISTORY_KEY, approvalDecisionViews } from "../approvals/approval-history.js";
import { readRegularFileNoFollow } from "../workspace/file-security.js";
import { exportHarnessGovernanceReport, harnessGovernanceReportSchema } from "../persistence/governance-report.js";
import type { GovernanceSessionSource } from "../persistence/governance-context.js";
import { TASK_BUDGET_ACCOUNT_KEY, TaskBudget } from "../runtime/task-budget.js";
import { harnessPolicyDecisionEventSchema } from "../runtime/policy-decisions.js";
import type { HarnessConfig } from "../runtime/config.js";
import { inspectUsageLedger, USAGE_LEDGER_KEY, UsageLedger } from "../runtime/usage-ledger.js";
import { HARNESS_VERSION } from "../version.js";

export const AUDIT_PACK_SCHEMA_VERSION = 1 as const;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVITY_EVENTS = 2000;
const COMPONENT_NAMES = ["governance-report.json", "approvals.json", "policy-decisions.json", "redaction.jsonl", "usage-ledger.json"] as const;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z.string().regex(/^[A-Za-z0-9._-]{1,80}(?:\/[A-Za-z0-9._-]{1,80}){0,3}$/);
const fileEntry = z.strictObject({ path: relativePath, sha256: digest, bytes: z.number().int().nonnegative().safe() });
const subjectSchema = z.strictObject({
  kind: z.enum(["run", "task"]),
  id: z.string().min(1).max(256),
  runIds: z.array(z.string().min(1).max(256)).min(1).max(64)
});
const unsignedManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("zhivex-harness-audit-pack"),
  integrity: z.literal("hmac-sha256"),
  exporterVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
  createdAt: z.iso.datetime(),
  subject: subjectSchema,
  files: z.array(fileEntry).min(5).max(320)
}).superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const file of value.files) {
    if (seen.has(file.path) || file.path === "manifest.json") ctx.addIssue({ code: "custom", message: "Duplicate or reserved audit pack path." });
    seen.add(file.path);
  }
});
const signatureSchema = z.strictObject({
  algorithm: z.literal("hmac-sha256"),
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
  value: z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
});
export const auditPackManifestSchema = unsignedManifestSchema.extend({ signature: signatureSchema });
export type AuditPackManifest = z.infer<typeof auditPackManifestSchema>;

const accountView = z.object({
  taskId: z.string().min(1).max(256),
  runs: z.array(z.string().min(1).max(256)).max(64)
}).passthrough();

function fail(code: string): never {
  throw new Error(code);
}
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
    : JSON.stringify(value) ?? "null";

/** Canonical bytes covered by the HMAC. The signature field is excluded. */
export const canonicalizeAuditPackManifest = (value: unknown) => canonical(unsignedManifestSchema.parse(value));

const keyIdFor = (key: Uint8Array) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const signManifest = (unsigned: unknown, key: Uint8Array) => createHmac("sha256", key).update(canonicalizeAuditPackManifest(unsigned)).digest("base64");
const assertKey = (key: Uint8Array) => {
  if (key.byteLength < 32 || key.byteLength > 4096) fail("AUDIT_PACK_KEY_INVALID");
};

const redaction = createRedactionPolicy({ includeEmails: true });
const redactText = (value: string) => redaction.redactText(value).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi, "[REDACTED]");
const redactValue = (value: unknown): unknown => typeof value === "string" ? redactText(value)
  : Array.isArray(value) ? value.map(redactValue)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]))
      : value;

const sameScope = (state: AgentRunState, scope: AgentStoreScope | undefined) => !state.scope ||
  state.scope.tenantId === scope?.tenantId && state.scope.userId === scope?.userId && state.scope.namespace === scope?.namespace;

const contained = (root: string, relativePath: string) => {
  if (relativePath.includes("\\") || path.isAbsolute(relativePath) || relativePath.split("/").some(part => part === "" || part === "." || part === "..")) fail("AUDIT_PACK_PATH_INVALID");
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("AUDIT_PACK_PATH_INVALID");
  return target;
};

const runSegment = (runId: string, used: Set<string>) => {
  const base = /^[A-Za-z0-9._-]{1,64}$/.test(runId) ? runId : `run-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`;
  used.add(name);
  return name;
};

type CapturedRun = { state: AgentRunState; journal: AgentToolCallJournalEntry[] | undefined };

async function loadRun(store: AgentRunStore, scope: AgentStoreScope | undefined, runId: string) {
  const state = await store.load(runId, scope);
  if (!state || state.runId !== runId || !sameScope(state, scope)) fail("AUDIT_PACK_SUBJECT_UNAVAILABLE");
  return structuredClone(state);
}

async function readJournal(store: AgentRunStore, scope: AgentStoreScope | undefined, runId: string) {
  if (!store.listToolCalls) return undefined;
  const listed = await store.listToolCalls(runId, scope);
  return listed ? structuredClone(listed) : undefined;
}

async function captureRun(store: AgentRunStore, scope: AgentStoreScope | undefined, runId: string): Promise<CapturedRun> {
  return { state: await loadRun(store, scope, runId), journal: await readJournal(store, scope, runId) };
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

async function assertCaptured(store: AgentRunStore, scope: AgentStoreScope | undefined, captured: CapturedRun) {
  const current = await store.load(captured.state.runId, scope);
  const currentJournal = store.listToolCalls ? await store.listToolCalls(captured.state.runId, scope) : undefined;
  if (!current || !sameJson(current, captured.state) || !sameJson(currentJournal, captured.journal)) fail("AUDIT_PACK_STATE_CHANGED");
}

function snapshotStore(real: AgentRunStore, captured: ReadonlyMap<string, CapturedRun>): AgentRunStore {
  return {
    async load(id, scope) {
      const snap = captured.get(id);
      if (snap) return structuredClone(snap.state);
      return real.load(id, scope);
    },
    ...(real.listToolCalls ? { async listToolCalls(id, scope) {
      const snap = captured.get(id);
      if (snap) return snap.journal ? structuredClone(snap.journal) : undefined;
      return real.listToolCalls!(id, scope);
    } } : {})
  } as AgentRunStore;
}

async function resolveSubject(store: AgentRunStore, scope: AgentStoreScope | undefined, subjectId: string) {
  const direct = await store.load(subjectId, scope);
  const accountOf = (state: AgentRunState | undefined) => {
    const parsed = accountView.safeParse(state?.metadata?.[TASK_BUDGET_ACCOUNT_KEY]);
    return parsed.success && state?.runId.startsWith("task_budget_") ? parsed.data : undefined;
  };
  const directAccount = direct && direct.runId === subjectId && sameScope(direct, scope) ? accountOf(direct) : undefined;
  if (direct && direct.runId === subjectId && sameScope(direct, scope) && !directAccount) {
    return { kind: "run" as const, id: subjectId, runs: [{ state: structuredClone(direct), journal: await readJournal(store, scope, subjectId) }], accountState: undefined as AgentRunState | undefined };
  }
  let account = directAccount;
  let taskId = account?.taskId;
  let accountState = direct && directAccount ? structuredClone(direct) : undefined;
  if (!account && scope) {
    const loaded = await store.load(TaskBudget.accountId(scope, subjectId), scope);
    const parsed = loaded && sameScope(loaded, scope) ? accountOf(loaded) : undefined;
    if (parsed && parsed.taskId === subjectId) {
      account = parsed;
      taskId = parsed.taskId;
      accountState = structuredClone(loaded!);
    }
  }
  if (!account || !taskId || !accountState || account.runs.length === 0) fail("AUDIT_PACK_SUBJECT_UNAVAILABLE");
  const runs = [];
  for (const runId of account.runs) runs.push(await captureRun(store, scope, runId));
  return { kind: "task" as const, id: taskId, runs, accountState };
}

function collectActivity(session: GovernanceSessionSource | undefined, runIds: ReadonlySet<string>) {
  if (!session?.history) return { availability: "unavailable" as const, truncated: false, retention: "unknown" as const, events: [] as Array<{ sequence: number; runId: string; at?: number; activity: Record<string, unknown> }> };
  const events: Array<{ sequence: number; runId: string; at?: number; activity: Record<string, unknown> }> = [];
  let cursor = 0;
  let truncated = false;
  let retention: "retained" | "expired" = "retained";
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const page = session.history.replay(session.id, cursor);
    if (page.schemaVersion !== 1 || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor) fail("AUDIT_PACK_HISTORY_INVALID");
    if (page.cursorExpired || page.policyEvidenceIncomplete) retention = "expired";
    let last = cursor;
    for (const event of page.events as Array<{ sessionId: string; runId: string; sequence: number; at?: number; activity: Record<string, unknown> }>) {
      if (event.sessionId !== session.id || !Number.isSafeInteger(event.sequence) || event.sequence <= last || event.sequence > page.nextCursor) fail("AUDIT_PACK_HISTORY_INVALID");
      last = event.sequence;
      if (!runIds.has(event.runId)) continue;
      if (events.length >= MAX_ACTIVITY_EVENTS) { truncated = true; continue; }
      events.push({ sequence: event.sequence, runId: event.runId, ...(typeof event.at === "number" ? { at: event.at } : {}), activity: event.activity });
    }
    if (page.cursorExpired || !page.hasMore) break;
    if (page.nextCursor === cursor) fail("AUDIT_PACK_HISTORY_INVALID");
    cursor = page.nextCursor;
    if (pageIndex === 49) truncated = true;
  }
  return { availability: truncated || retention === "expired" ? "incomplete" as const : "recorded" as const, truncated, retention, events };
}

function approvalPages(state: AgentRunState, journal: readonly AgentToolCallJournalEntry[]) {
  const decisions = [];
  for (let offset = 0; offset < 512; offset += 25) {
    const rows = approvalDecisionViews(state, journal, offset);
    decisions.push(...rows);
    if (rows.length < 25) break;
  }
  return decisions;
}

async function componentFiles(captured: CapturedRun, store: AgentRunStore, scope: AgentStoreScope | undefined, session: GovernanceSessionSource | undefined, activity: ReturnType<typeof collectActivity>, ledger: UsageLedger | undefined) {
  const state = captured.state;
  const rows = captured.journal ?? [];
  let approvals: { schemaVersion: 1; kind: "zhivex-audit-approvals"; runId: string; availability: "recorded" | "unavailable" | "invalid"; decisions: unknown[] };
  try {
    const decisions = approvalPages(state, rows);
    approvals = { schemaVersion: 1, kind: "zhivex-audit-approvals", runId: state.runId, availability: state.metadata?.[APPROVAL_HISTORY_KEY] === undefined && decisions.length === 0 ? "unavailable" : "recorded", decisions: redactValue(decisions) as unknown[] };
  } catch {
    approvals = { schemaVersion: 1, kind: "zhivex-audit-approvals", runId: state.runId, availability: "invalid", decisions: [] };
  }
  const policyEvents = [];
  let invalid = 0;
  for (const event of activity.events) {
    if (event.runId !== state.runId || event.activity.type !== "policy-decision") continue;
    const parsed = harnessPolicyDecisionEventSchema.safeParse(event.activity);
    if (!parsed.success) { invalid += 1; continue; }
    policyEvents.push({ sequence: event.sequence, event: parsed.data });
  }
  const policy = {
    schemaVersion: 1 as const,
    kind: "zhivex-audit-policy-decisions" as const,
    runId: state.runId,
    availability: activity.availability === "unavailable" ? "unavailable" as const : invalid > 0 || activity.availability === "incomplete" ? "incomplete" as const : "recorded" as const,
    invalid,
    decisions: policyEvents
  };
  const own = activity.events.filter(event => event.runId === state.runId);
  const header = { schemaVersion: 1, kind: "zhivex-redaction-log", availability: activity.availability, count: own.length, truncated: activity.truncated, retention: activity.retention };
  const lines = [header, ...own.map(event => ({ schemaVersion: 1, kind: "zhivex-redacted-activity", sequence: event.sequence, runId: event.runId, ...(event.at === undefined ? {} : { at: event.at }), activity: event.activity }))];
  const redactionLog = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
  let transport: unknown = null;
  let transportAvailability: "recorded" | "unavailable" = "unavailable";
  if (ledger) {
    try { transport = ledger.summary(state.runId); transportAvailability = "recorded"; }
    catch { transport = null; transportAvailability = "unavailable"; }
  }
  const usage = {
    schemaVersion: 1 as const,
    kind: "zhivex-audit-usage-ledger" as const,
    runId: state.runId,
    projection: inspectUsageLedger(state.metadata?.[USAGE_LEDGER_KEY]),
    transport,
    transportAvailability
  };
  const report = await exportHarnessGovernanceReport(store, scope, state.runId, session ? { session } : {});
  return new Map<string, Buffer>([
    ["governance-report.json", Buffer.from(`${JSON.stringify(report, null, 2)}\n`)],
    ["approvals.json", Buffer.from(`${JSON.stringify(approvals, null, 2)}\n`)],
    ["policy-decisions.json", Buffer.from(`${JSON.stringify(policy, null, 2)}\n`)],
    ["redaction.jsonl", Buffer.from(redactionLog)],
    ["usage-ledger.json", Buffer.from(`${JSON.stringify(usage, null, 2)}\n`)]
  ]);
}

export interface AuditPackExportOptions {
  store: AgentRunStore;
  scope?: AgentStoreScope;
  subjectId: string;
  directory: string;
  signingKey: Uint8Array;
  now?: number;
  session?: GovernanceSessionSource;
  config?: HarnessConfig;
}
export interface AuditPackVerifyOptions { directory: string; signingKey: Uint8Array }
export interface AuditPackVerification {
  schemaVersion: 1;
  kind: "zhivex-audit-pack-verification";
  subject: z.infer<typeof subjectSchema>;
  fileCount: number;
  keyId: string;
}

/** Read a configured HMAC key. File bytes override an explicit value. A trailing newline is ignored. */
export async function loadAuditSigningKey(input: { file?: string; value?: string }): Promise<Buffer> {
  let bytes: Buffer;
  if (input.file) {
    const data = await readRegularFileNoFollow(path.resolve(input.file), { label: "Audit signing key", maxBytes: 4096 });
    bytes = data.contents;
    if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, -1);
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
  } else if (input.value !== undefined) bytes = Buffer.from(input.value, "utf8");
  else fail("AUDIT_PACK_KEY_INVALID");
  assertKey(bytes);
  return Buffer.from(bytes);
}

/** One signed directory for a run, or for every run recorded on a guided task account. */
export async function exportHarnessAuditPack(options: AuditPackExportOptions): Promise<AuditPackManifest> {
  assertKey(options.signingKey);
  const subject = await resolveSubject(options.store, options.scope, options.subjectId);
  const runIds = new Set(subject.runs.map(run => run.state.runId));
  const activity = collectActivity(options.session, runIds);
  let ledger: UsageLedger | undefined;
  if (options.config) {
    try { ledger = await UsageLedger.open(options.config); }
    catch { ledger = undefined; }
  }
  try {
    const files = new Map<string, Buffer>();
    const segments = new Set<string>();
    const frozen = snapshotStore(options.store, new Map(subject.runs.map(run => [run.state.runId, run])));
    const prefixFor = subject.runs.length === 1 ? (_runId: string) => "" : (runId: string) => `runs/${runSegment(runId, segments)}/`;
    for (const captured of subject.runs) {
      const prefix = prefixFor(captured.state.runId);
      const parts = await componentFiles(captured, frozen, options.scope, options.session, activity, ledger);
      for (const name of COMPONENT_NAMES) {
        const bytes = parts.get(name);
        if (!bytes) fail("AUDIT_PACK_CONTENT_INVALID");
        if (bytes.byteLength > MAX_FILE_BYTES) fail("AUDIT_PACK_LIMIT");
        files.set(`${prefix}${name}`, bytes);
      }
    }
    const listed = [...files.keys()].sort();
    let total = 0;
    const entries = listed.map(file => {
      const bytes = files.get(file)!;
      total += bytes.byteLength;
      return { path: file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
    });
    for (const captured of subject.runs) await assertCaptured(options.store, options.scope, captured);
    if (subject.accountState) {
      const currentAccount = await options.store.load(subject.accountState.runId, options.scope);
      if (!currentAccount || !sameJson(currentAccount, subject.accountState)) fail("AUDIT_PACK_STATE_CHANGED");
    }
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "zhivex-harness-audit-pack" as const,
      integrity: "hmac-sha256" as const,
      exporterVersion: HARNESS_VERSION,
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
      subject: { kind: subject.kind, id: subject.id, runIds: subject.runs.map(run => run.state.runId) },
      files: entries
    };
    const manifest = auditPackManifestSchema.parse({
      ...unsigned,
      signature: { algorithm: "hmac-sha256" as const, keyId: keyIdFor(options.signingKey), value: signManifest(unsigned, options.signingKey) }
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.byteLength > MAX_FILE_BYTES || total + manifestBytes.byteLength > MAX_PACK_BYTES) fail("AUDIT_PACK_LIMIT");
    const directory = path.resolve(options.directory);
    const parent = await lstat(path.dirname(directory)).catch(() => fail("AUDIT_PACK_OUTPUT_UNAVAILABLE"));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("AUDIT_PACK_OUTPUT_UNAVAILABLE");
    await mkdir(directory, { mode: 0o700 }).catch(error => fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "AUDIT_PACK_OUTPUT_EXISTS" : "AUDIT_PACK_OUTPUT_UNAVAILABLE"));
    try {
      for (const file of listed) {
        const target = contained(directory, file);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, files.get(file)!, { flag: "wx", mode: 0o600 });
      }
      await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (error instanceof Error && error.message.startsWith("AUDIT_PACK_")) throw error;
      fail("AUDIT_PACK_WRITE_FAILED");
    }
    return manifest;
  } finally { ledger?.close(); }
}

const kindSchema = (kind: string) => z.object({ schemaVersion: z.literal(1), kind: z.literal(kind) }).passthrough();

/** Recompute file hashes and the HMAC. A valid signature does not authorize paths outside the directory. */
export async function verifyHarnessAuditPack(options: AuditPackVerifyOptions): Promise<AuditPackVerification> {
  assertKey(options.signingKey);
  const directory = path.resolve(options.directory);
  const root = await lstat(directory).catch(() => fail("AUDIT_PACK_UNAVAILABLE"));
  if (!root.isDirectory() || root.isSymbolicLink()) fail("AUDIT_PACK_UNAVAILABLE");
  const manifestBytes = await readRegularFileNoFollow(path.join(directory, "manifest.json"), { label: "Audit manifest", maxBytes: MAX_FILE_BYTES });
  let manifest: AuditPackManifest;
  try { manifest = auditPackManifestSchema.parse(JSON.parse(manifestBytes.contents.toString("utf8"))); }
  catch { fail("AUDIT_PACK_MANIFEST_INVALID"); }
  const present: string[] = [];
  const walk = async (current: string, prefix: string) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail("AUDIT_PACK_PATH_INVALID");
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, relative);
      else if (entry.isFile()) present.push(relative);
      else fail("AUDIT_PACK_PATH_INVALID");
    }
  };
  await walk(directory, "");
  present.sort();
  const expected = ["manifest.json", ...manifest.files.map(file => file.path)].sort();
  if (present.length !== expected.length || present.some((file, index) => file !== expected[index])) fail("AUDIT_PACK_FILES_MISMATCH");
  let total = manifestBytes.contents.byteLength;
  for (const file of manifest.files) {
    const target = contained(directory, file.path);
    const contents = await readRegularFileNoFollow(target, { label: "Audit pack file", maxBytes: MAX_FILE_BYTES }).catch(error => {
      if (error instanceof Error && error.message.startsWith("AUDIT_PACK_")) throw error;
      fail("AUDIT_PACK_HASH_MISMATCH");
    });
    total += contents.contents.byteLength;
    if (contents.contents.byteLength !== file.bytes || createHash("sha256").update(contents.contents).digest("hex") !== file.sha256) fail("AUDIT_PACK_HASH_MISMATCH");
    try {
      if (file.path.endsWith("governance-report.json")) {
        if (!harnessGovernanceReportSchema.safeParse(JSON.parse(contents.contents.toString("utf8"))).success) fail("AUDIT_PACK_CONTENT_INVALID");
      } else if (file.path.endsWith("approvals.json")) {
        if (!kindSchema("zhivex-audit-approvals").safeParse(JSON.parse(contents.contents.toString("utf8"))).success) fail("AUDIT_PACK_CONTENT_INVALID");
      } else if (file.path.endsWith("policy-decisions.json")) {
        if (!kindSchema("zhivex-audit-policy-decisions").safeParse(JSON.parse(contents.contents.toString("utf8"))).success) fail("AUDIT_PACK_CONTENT_INVALID");
      } else if (file.path.endsWith("usage-ledger.json")) {
        if (!kindSchema("zhivex-audit-usage-ledger").safeParse(JSON.parse(contents.contents.toString("utf8"))).success) fail("AUDIT_PACK_CONTENT_INVALID");
      } else if (file.path.endsWith("redaction.jsonl")) {
        const lines = contents.contents.toString("utf8").split("\n");
        if (lines.at(-1) !== "") fail("AUDIT_PACK_CONTENT_INVALID");
        for (const line of lines.slice(0, -1)) {
          if (!kindSchema("zhivex-redaction-log").or(kindSchema("zhivex-redacted-activity")).safeParse(JSON.parse(line)).success) fail("AUDIT_PACK_CONTENT_INVALID");
        }
      } else fail("AUDIT_PACK_PATH_INVALID");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("AUDIT_PACK_")) throw error;
      fail("AUDIT_PACK_CONTENT_INVALID");
    }
  }
  if (total > MAX_PACK_BYTES) fail("AUDIT_PACK_LIMIT");
  if (manifest.signature.keyId !== keyIdFor(options.signingKey)) fail("AUDIT_PACK_KEY_MISMATCH");
  const { signature, ...unsigned } = manifest;
  const expectedSignature = Buffer.from(signManifest(unsigned, options.signingKey), "base64");
  const actualSignature = Buffer.from(signature.value, "base64");
  if (actualSignature.length !== expectedSignature.length || actualSignature.toString("base64") !== signature.value || !timingSafeEqual(actualSignature, expectedSignature)) {
    fail("AUDIT_PACK_SIGNATURE_INVALID");
  }
  return { schemaVersion: 1, kind: "zhivex-audit-pack-verification", subject: manifest.subject, fileCount: manifest.files.length, keyId: signature.keyId };
}
