import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Opt-in approval policy. Manual is the default. Always-ask reasons are checked before any mode or allowlist. */
export const AUTO_APPROVE_MODES = ["manual", "auto-edits", "auto-limits"] as const;
export type AutoApproveMode = (typeof AUTO_APPROVE_MODES)[number];

export interface AutoApprovePolicy {
  mode: AutoApproveMode;
  commandAllowlist: readonly string[];
  rootDir: string;
  overLimit?: boolean;
}

export interface ApprovalPath {
  path: string;
  operation?: "create" | "update" | "delete" | "move" | "restore";
}

export interface ApprovalFacts {
  name: string;
  paths: readonly ApprovalPath[];
  commands: readonly string[];
}

export type AskReason =
  | "manual"
  | "not-an-edit"
  | "not-allowlisted"
  | "unproven-path"
  | "network"
  | "delete-outside"
  | "write-outside"
  | "secret"
  | "git-push"
  | "package-publish"
  | "over-limit";

export type ClassifyResult =
  | { decision: "ask"; reason: AskReason }
  | { decision: "auto"; reason: "edit-in-root" | "allowlisted-command" };

export interface ApprovalConfigFile {
  mode: AutoApproveMode;
  commandAllowlist: string[];
}

export interface AutoApprovalSnapshot {
  path: string;
  before: string | null;
  after: string | null;
  undoable: boolean;
}

export interface AutoApprovalAuditEntry {
  id: string;
  approvalId: string;
  name: string;
  mode: Exclude<AutoApproveMode, "manual">;
  reason: string;
  timestamp: string;
  snapshots: AutoApprovalSnapshot[];
}

export interface PublicAutoApproval {
  id: string;
  name: string;
  mode: Exclude<AutoApproveMode, "manual">;
  reason: string;
  timestamp: string;
  paths: string[];
  undoable: boolean;
}

const EDIT_TOOLS = new Set([
  "apply_patch",
  "apply_reviewed_edits",
  "apply_reviewed_replacement",
  "verify_and_apply_reviewed_edits",
]);

const COMMAND_TOOLS = new Set([
  "run_check",
  "run_environment_command",
  "run_environment_shell",
  "run_environment_batch",
  "apply_environment_patch",
  "verify_and_apply_environment_patch",
]);

const NETWORK_BINARIES = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "nc", "ncat", "netcat", "telnet", "ftp",
  "ping", "dig", "nslookup", "host", "socat", "rsync", "aria2c", "fetch",
]);

const NETWORK_TOOLS = new Set(["fetch", "web_fetch", "http_request", "browse_page", "net_request"]);
const DELETE_BINARIES = new Set(["rm", "rmdir", "unlink", "del"]);
const ALLOWLIST_NAME = /^[A-Za-z0-9._+-]+$/;
const SNAPSHOT_BYTES = 256 * 1024;

export const approvalConfigPath = (rootDir: string) => path.join(rootDir, ".zhivex-harness", "approval.json");
export const autoApprovalLogPath = (rootDir: string) => path.join(rootDir, ".zhivex-harness", "auto-approvals.jsonl");

export const isAutoApproveMode = (value: string): value is AutoApproveMode =>
  (AUTO_APPROVE_MODES as readonly string[]).includes(value);

/** Exact executable names only. Wildcards, paths and shell syntax are rejected. */
export const parseAllowlist = (entries: readonly string[]) => {
  const names: string[] = [];
  for (const entry of entries) {
    const name = entry.trim().toLowerCase();
    if (!ALLOWLIST_NAME.test(name) || name.includes("*") || name.includes("/") || name.includes("\\")) {
      throw new Error(`AUTO_APPROVE_ALLOWLIST_INVALID:${entry}`);
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
};

export const parseApprovalConfig = (text: string): ApprovalConfigFile => {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("AUTO_APPROVE_CONFIG_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AUTO_APPROVE_CONFIG_INVALID");
  const record = parsed as { mode?: unknown; commandAllowlist?: unknown };
  const keys = Object.keys(record).sort();
  if (keys.some(key => key !== "mode" && key !== "commandAllowlist")) throw new Error("AUTO_APPROVE_CONFIG_INVALID");
  const mode = record.mode ?? "manual";
  if (typeof mode !== "string" || !isAutoApproveMode(mode)) throw new Error("AUTO_APPROVE_CONFIG_INVALID");
  const list = record.commandAllowlist ?? [];
  if (!Array.isArray(list) || list.some(item => typeof item !== "string")) throw new Error("AUTO_APPROVE_CONFIG_INVALID");
  return { mode, commandAllowlist: parseAllowlist(list) };
};

export const resolveAutoApprovePolicy = (input: {
  rootDir: string;
  overLimit?: boolean;
  file?: ApprovalConfigFile | null;
  cliMode?: AutoApproveMode;
  cliAllow?: readonly string[];
  sessionMode?: AutoApproveMode;
  sessionAllow?: readonly string[];
}): AutoApprovePolicy => {
  const mode = input.sessionMode ?? input.cliMode ?? input.file?.mode ?? "manual";
  const listed = input.sessionAllow ?? (input.cliAllow && input.cliAllow.length ? input.cliAllow : input.file?.commandAllowlist ?? []);
  return {
    mode,
    commandAllowlist: parseAllowlist(listed),
    rootDir: input.rootDir,
    ...(input.overLimit ? { overLimit: true } : {}),
  };
};

export const isInsideRoot = (rootDir: string, candidate: string) => {
  if (!candidate || candidate.includes("\0") || candidate.startsWith("~")) return false;
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

export const isSecretPath = (candidate: string) => {
  const normalized = candidate.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (/^\.env($|\.)/i.test(base)) return true;
  if (/^(credentials|credentials\..+|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)$/i.test(base)) return true;
  if (/\.(pem|key)$/i.test(base)) return true;
  if (normalized.split("/").some(segment => /^(secrets?|credentials|\.secrets)$/i.test(segment))) return true;
  return /credential/i.test(base);
};

const tokenize = (command: string) => {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  return tokens;
};

const executable = (token: string) => (token.replaceAll("\\", "/").split("/").pop() ?? token).replace(/\.exe$/i, "").toLowerCase();

const inspectCommand = (command: string) => {
  const tokens = tokenize(command.trim());
  return { binary: executable(tokens[0] ?? ""), args: tokens.slice(1), raw: command };
};

const isGitPush = (command: ReturnType<typeof inspectCommand>) =>
  command.binary === "git" && command.args.some(arg => arg === "push");

const isPackagePublish = (command: ReturnType<typeof inspectCommand>) => {
  const args = command.args.filter(arg => !arg.startsWith("-"));
  if (["npm", "pnpm", "yarn", "bun"].includes(command.binary) && args.includes("publish")) return true;
  if (command.binary === "yarn" && args[0] === "npm" && args.includes("publish")) return true;
  if (command.binary === "bun" && args[0] === "pm" && args.includes("publish")) return true;
  return command.binary === "cargo" && args.includes("publish");
};

const isNetworkCommand = (command: ReturnType<typeof inspectCommand>) =>
  NETWORK_BINARIES.has(command.binary) || /https?:\/\//i.test(command.raw) || /\b(ssh|scp|sftp):\/\//i.test(command.raw);

const pathTokens = (tokens: readonly string[]) =>
  tokens.filter(token => token.startsWith("/") || token.startsWith("~") || token.includes("..") || token.startsWith("./"));

const commandAlwaysAsk = (command: ReturnType<typeof inspectCommand>, rootDir: string): AskReason | undefined => {
  if (isGitPush(command)) return "git-push";
  if (isPackagePublish(command)) return "package-publish";
  if (isNetworkCommand(command)) return "network";
  const tokens = [command.binary, ...command.args];
  for (const token of tokens) if (isSecretPath(token)) return "secret";
  for (const token of pathTokens(command.args)) {
    if (!isInsideRoot(rootDir, token)) return DELETE_BINARIES.has(command.binary) ? "delete-outside" : "write-outside";
  }
  if (DELETE_BINARIES.has(command.binary)) {
    for (const arg of command.args) {
      if (arg.startsWith("-")) continue;
      if (!isInsideRoot(rootDir, arg)) return "delete-outside";
    }
  }
  return undefined;
};

const fileAlwaysAsk = (file: ApprovalPath, rootDir: string): AskReason | undefined => {
  if (isSecretPath(file.path)) return "secret";
  if (!isInsideRoot(rootDir, file.path)) return file.operation === "delete" ? "delete-outside" : "write-outside";
  return undefined;
};

const commandsAllowlisted = (commands: readonly string[], policy: AutoApprovePolicy) =>
  commands.every(command => {
    const inspected = inspectCommand(command);
    return inspected.binary !== "" && policy.commandAllowlist.includes(inspected.binary);
  });

/** Always-ask is decided before mode and before the command allowlist. There is no force flag. */
export const classifyApproval = (facts: ApprovalFacts, policy: AutoApprovePolicy): ClassifyResult => {
  if (policy.overLimit) return { decision: "ask", reason: "over-limit" };
  if (NETWORK_TOOLS.has(facts.name) || facts.name.includes("egress")) return { decision: "ask", reason: "network" };
  for (const file of facts.paths) {
    const reason = fileAlwaysAsk(file, policy.rootDir);
    if (reason) return { decision: "ask", reason };
  }
  for (const command of facts.commands) {
    const reason = commandAlwaysAsk(inspectCommand(command), policy.rootDir);
    if (reason) return { decision: "ask", reason };
  }
  if (policy.mode === "manual") return { decision: "ask", reason: "manual" };
  if (EDIT_TOOLS.has(facts.name)) {
    if (!facts.paths.length) return { decision: "ask", reason: "unproven-path" };
    if (facts.commands.length) {
      if (policy.mode !== "auto-limits" || !commandsAllowlisted(facts.commands, policy)) {
        return { decision: "ask", reason: "not-allowlisted" };
      }
    }
    return { decision: "auto", reason: "edit-in-root" };
  }
  if (policy.mode === "auto-limits" && COMMAND_TOOLS.has(facts.name)) {
    if (!facts.commands.length || !commandsAllowlisted(facts.commands, policy)) return { decision: "ask", reason: "not-allowlisted" };
    return { decision: "auto", reason: "allowlisted-command" };
  }
  return { decision: "ask", reason: policy.mode === "auto-edits" ? "not-an-edit" : "not-allowlisted" };
};

export const approvalFacts = (name: string, argumentsText: string): ApprovalFacts => {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { /* Unparseable input cannot prove it is inside the workspace. */ }
  const paths: ApprovalPath[] = [];
  const commands: string[] = [];
  const pushPath = (value: unknown, operation: NonNullable<ApprovalPath["operation"]>) => {
    if (typeof value === "string") paths.push({ path: value, operation });
  };
  if (typeof args.path === "string") {
    pushPath(args.path, args.content === null || args.newText === null ? "delete" : args.expectedDigest === null ? "create" : "update");
  }
  pushPath(args.source, "move");
  pushPath(args.destination, "move");
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) {
      if (!change || typeof change !== "object") continue;
      const record = change as { path?: unknown; content?: unknown; expectedDigest?: unknown };
      if (typeof record.path !== "string") continue;
      paths.push({
        path: record.path,
        operation: record.content === null ? "delete" : record.expectedDigest === null ? "create" : "update",
      });
    }
  }
  const pushCommand = (value: unknown) => { if (typeof value === "string" && value.trim()) commands.push(value); };
  pushCommand(args.expectedScript);
  pushCommand(args.script);
  if (typeof args.command === "string") {
    const extra = Array.isArray(args.args) ? args.args.filter((item): item is string => typeof item === "string") : [];
    commands.push([args.command, ...extra].join(" "));
  }
  if (Array.isArray(args.commands)) {
    for (const entry of args.commands) {
      if (typeof entry === "string") commands.push(entry);
      else if (entry && typeof entry === "object" && typeof (entry as { command?: unknown }).command === "string") {
        const record = entry as { command: string; args?: unknown };
        const extra = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
        commands.push([record.command, ...extra].join(" "));
      }
    }
  }
  if (Array.isArray(args.checks)) {
    for (const check of args.checks) {
      if (check && typeof check === "object") pushCommand((check as { expectedScript?: unknown }).expectedScript);
    }
  }
  return { name, paths, commands };
};

/** A whole pending batch auto-resolves only when every item is auto. One always-ask item keeps the batch for a person. */
export const decideBatch = (items: readonly { name?: string; arguments?: string }[], policy: AutoApprovePolicy) => {
  if (!items.length) return { auto: false as const, reason: "manual" as const };
  const results = items.map(item => classifyApproval(approvalFacts(item.name ?? "unknown", item.arguments ?? "{}"), policy));
  if (results.every(result => result.decision === "auto")) return { auto: true as const, results };
  const blocking = results.find(result => result.decision === "ask");
  return { auto: false as const, reason: blocking && blocking.decision === "ask" ? blocking.reason : "manual" };
};

export const snapshotText = (bytes: Buffer | null) => {
  if (bytes === null) return { text: null, undoable: true };
  if (bytes.byteLength > SNAPSHOT_BYTES || bytes.includes(0)) return { text: null, undoable: false };
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text, "utf8"))) return { text: null, undoable: false };
  return { text, undoable: true };
};

export const buildSnapshots = (
  argumentsText: string,
  read: (relativePath: string) => { text: string | null; undoable: boolean },
): AutoApprovalSnapshot[] => {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch { return []; }
  const snapshots: AutoApprovalSnapshot[] = [];
  if (typeof args.path === "string" && typeof args.oldText === "string" && typeof args.newText === "string") {
    const current = read(args.path);
    const after = current.undoable && current.text !== null && current.text.includes(args.oldText)
      ? current.text.replace(args.oldText, args.newText) : null;
    snapshots.push({ path: args.path, before: current.text, after, undoable: current.undoable && after !== null });
  }
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) {
      if (!change || typeof change !== "object" || typeof (change as { path?: unknown }).path !== "string") continue;
      const record = change as { path: string; content?: unknown };
      const current = read(record.path);
      const after = typeof record.content === "string" ? record.content : record.content === null ? null : null;
      const undoable = current.undoable && (typeof record.content === "string" || record.content === null);
      snapshots.push({ path: record.path, before: current.undoable ? current.text : null, after, undoable });
    }
  }
  return snapshots;
};

export const planUndo = (entry: AutoApprovalAuditEntry, current: ReadonlyMap<string, string | null>) => {
  if (!entry.snapshots.length || entry.snapshots.some(item => !item.undoable)) {
    return { ok: false as const, reason: "This auto-approval has no restorable snapshot." };
  }
  for (const snap of entry.snapshots) {
    if (!current.has(snap.path)) return { ok: false as const, reason: "Current file contents are not available." };
    if ((current.get(snap.path) ?? null) !== snap.after) {
      return { ok: false as const, reason: "The file changed after the auto-approval, so it was not reverted." };
    }
  }
  return { ok: true as const, writes: entry.snapshots.map(snap => ({ path: snap.path, contents: snap.before })) };
};

export const publicAutoApproval = (entry: AutoApprovalAuditEntry): PublicAutoApproval => ({
  id: entry.id,
  name: entry.name,
  mode: entry.mode,
  reason: entry.reason,
  timestamp: entry.timestamp,
  paths: entry.snapshots.map(item => item.path),
  undoable: entry.snapshots.length > 0 && entry.snapshots.every(item => item.undoable),
});

const safeLogFile = async (file: string) => {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("AUTO_APPROVE_LOG_UNSAFE");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const readAutoApprovals = async (rootDir: string): Promise<AutoApprovalAuditEntry[]> => {
  const file = autoApprovalLogPath(rootDir);
  if (!await safeLogFile(file)) return [];
  const text = await readFile(file, "utf8");
  const entries: AutoApprovalAuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as AutoApprovalAuditEntry); }
    catch { /* Skip a damaged line rather than hiding the rest of the log. */ }
  }
  return entries;
};

export const appendAutoApproval = async (rootDir: string, entry: AutoApprovalAuditEntry) => {
  const directory = path.join(rootDir, ".zhivex-harness");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = autoApprovalLogPath(rootDir);
  const exists = await safeLogFile(file);
  const previous = exists ? await readFile(file, "utf8") : "";
  const lines = [...previous.split("\n").filter(Boolean), JSON.stringify(entry)].slice(-100);
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
};

export const loadApprovalConfig = async (rootDir: string): Promise<ApprovalConfigFile> => {
  const file = approvalConfigPath(rootDir);
  const exists = await safeLogFile(file);
  if (!exists) return { mode: "manual", commandAllowlist: [] };
  return parseApprovalConfig(await readFile(file, "utf8"));
};

export const writeApprovalConfig = async (rootDir: string, config: ApprovalConfigFile) => {
  const directory = path.join(rootDir, ".zhivex-harness");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = approvalConfigPath(rootDir);
  await safeLogFile(file);
  const stored = { mode: config.mode, commandAllowlist: parseAllowlist(config.commandAllowlist) };
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
};

export const createAutoApprovalEntry = (input: {
  approvalId: string;
  name: string;
  mode: Exclude<AutoApproveMode, "manual">;
  reason: string;
  snapshots: AutoApprovalSnapshot[];
}): AutoApprovalAuditEntry => ({
  id: `auto_${randomUUID()}`,
  approvalId: input.approvalId,
  name: input.name,
  mode: input.mode,
  reason: input.reason,
  timestamp: new Date().toISOString(),
  snapshots: input.snapshots,
});

const readCurrent = async (rootDir: string, relativePath: string) => {
  if (!isInsideRoot(rootDir, relativePath)) return undefined;
  const full = path.resolve(rootDir, relativePath);
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    if (info.size > SNAPSHOT_BYTES) return undefined;
    const bytes = await readFile(full);
    const text = snapshotText(bytes);
    return text.undoable ? text.text : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
};

export const readWorkspaceSnapshot = async (rootDir: string, relativePath: string) => {
  const text = await readCurrent(rootDir, relativePath);
  if (text === undefined) return { text: null, undoable: false };
  return { text, undoable: true };
};

export const revertAutoApproval = async (rootDir: string, id: string) => {
  const entries = await readAutoApprovals(rootDir);
  const entry = entries.find(item => item.id === id);
  if (!entry) return { ok: false as const, reason: "That auto-approval is not in the audit log." };
  const current = new Map<string, string | null>();
  for (const snap of entry.snapshots) {
    const text = await readCurrent(rootDir, snap.path);
    if (text === undefined) return { ok: false as const, reason: "A file in this auto-approval can no longer be read safely." };
    current.set(snap.path, text);
  }
  const plan = planUndo(entry, current);
  if (!plan.ok) return plan;
  for (const write of plan.writes) {
    if (!isInsideRoot(rootDir, write.path)) return { ok: false as const, reason: "The snapshot path leaves the workspace." };
    const full = path.resolve(rootDir, write.path);
    if (write.contents === null) await unlink(full).catch(() => undefined);
    else await writeFile(full, write.contents, "utf8");
  }
  return { ok: true as const, paths: plan.writes.map(write => write.path) };
};
