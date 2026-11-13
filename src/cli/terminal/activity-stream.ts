import { createRedactionPolicy } from "@zhivex-ai/agents";
import { sanitizeTerminalText } from "./terminal-ui.js";
import { compactToolResult } from "./tool-activity.js";

const redaction = createRedactionPolicy({ includeEmails: true });
const SECRETISH = /password|secret|api[_-]?key|token|authorization|bearer/i;

export interface TurnDiff {
  added: number;
  removed: number;
}

export interface ActivityEmission {
  live: string;
  history: string[];
}

interface ExploreItem {
  kind: "read" | "search" | "list" | "diff";
  files: number;
  line: string;
}

interface EditGroup {
  path: string;
  added: number;
  removed: number;
  attempts: number;
  stats: boolean;
  intent?: string;
  details: string[];
}

const EDIT_TOOLS = new Set(["apply_patch", "apply_reviewed_edits", "apply_reviewed_replacement"]);
const EXPLORE_TOOLS = new Set(["read_file", "read_files", "search_files", "search_many", "list_files", "git_diff", "read_dependency"]);
const CHECK_TOOLS = new Set(["run_check", "run_environment_command", "run_environment_shell", "run_environment_batch"]);
const KNOWN_TOOLS = new Set([...EDIT_TOOLS, ...EXPLORE_TOOLS, ...CHECK_TOOLS, "propose_edits", "move_file", "quarantine_file", "restore_file", "apply_environment_patch"]);

const isCheck = (name: string) => CHECK_TOOLS.has(name) || name.startsWith("verify_and_apply_");
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const safe = (value: string, limit = 160) =>
  redaction.redactText(sanitizeTerminalText(value)).replace(/[\r\n\t]/g, " ").trim().slice(0, limit);

const clipLive = (line: string) => {
  const clean = line.replace(/[\r\n]/g, " ");
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean;
};

const emission = (line: string, children: string[] = []): ActivityEmission => ({
  live: clipLive(line),
  history: [clipLive(line), ...children.map(child => child.slice(0, 500))]
});

const lineCount = (text: string) => {
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts.length;
};

const lineRange = (start: unknown, end: unknown) => {
  const from = typeof start === "number" && Number.isSafeInteger(start) ? start : undefined;
  const to = typeof end === "number" && Number.isSafeInteger(end) ? end : undefined;
  if (from !== undefined && to !== undefined) return ` L${from}-${to}`;
  if (from !== undefined && from !== 1) return ` L${from}`;
  return "";
};

const baseName = (path: string) => path.split(/[/\\]/).pop() || path;

const editPath = (name: string, input: unknown) => {
  const record = asRecord(input);
  if (!record) return "";
  if (name === "apply_reviewed_replacement" && typeof record.path === "string") return record.path;
  if (!Array.isArray(record.changes)) return typeof record.path === "string" ? record.path : "";
  const paths = record.changes
    .map(change => asRecord(change)?.path)
    .filter((path): path is string => typeof path === "string");
  if (paths.length === 1) return paths[0] ?? "";
  if (paths.length > 1) return paths.join("\n");
  return "";
};

const editLabel = (path: string) => path.includes("\n") ? `${path.split("\n").length} files` : safe(baseName(path), 80);

const statedIntent = (input: unknown) => {
  const record = asRecord(input);
  if (!record) return;
  for (const key of ["intent", "reason", "summary", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && !SECRETISH.test(value)) return safe(value.trim().split("\n")[0] ?? "", 60);
  }
  return undefined;
};

const inferredIntent = (oldText: string, newText: string) => {
  const previous = new Set(oldText.split("\n").map(line => line.trim()));
  for (const line of newText.split("\n")) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    if (trimmed.length < 8 || trimmed.length > 80 || previous.has(trimmed) || SECRETISH.test(trimmed)) continue;
    return safe(trimmed, 60);
  }
  return undefined;
};

const replacementStats = (input: unknown) => {
  const record = asRecord(input);
  if (!record || typeof record.oldText !== "string" || typeof record.newText !== "string") return;
  return {
    added: lineCount(record.newText),
    removed: lineCount(record.oldText),
    intent: statedIntent(record) ?? inferredIntent(record.oldText, record.newText)
  };
};

const matchedFiles = (output: unknown) => {
  const record = asRecord(output);
  if (!record) return;
  const paths = new Set<string>();
  const take = (matches: unknown) => {
    if (!Array.isArray(matches)) return false;
    for (const match of matches) {
      const path = asRecord(match)?.path;
      if (typeof path === "string") paths.add(path);
    }
    return true;
  };
  const direct = take(record.matches);
  let nested = false;
  let truncated = record.truncated === true;
  if (Array.isArray(record.results)) {
    for (const result of record.results) {
      const item = asRecord(result);
      if (take(item?.matches)) nested = true;
      if (item?.truncated === true) truncated = true;
    }
  }
  if (!direct && !nested) return;
  return { files: paths.size, truncated };
};

const readLine = (input: unknown) => {
  const record = asRecord(input);
  const path = typeof record?.path === "string" ? safe(record.path) : "a file";
  return `Read ${path}${lineRange(record?.startLine, record?.endLine)}`;
};

const readFilesLine = (input: unknown) => {
  const files = asRecord(input)?.files;
  if (!Array.isArray(files) || files.length === 0) return "Read files";
  const parts = files.slice(0, 3).map(file => {
    const record = asRecord(file);
    const path = typeof record?.path === "string" ? safe(record.path, 80) : "a file";
    return `${path}${lineRange(record?.startLine, record?.endLine)}`;
  });
  const more = files.length > 3 ? ` · +${files.length - 3} more` : "";
  return `Read ${parts.join(", ")}${more}`;
};

const searchLine = (name: string, input: unknown, output: unknown) => {
  const record = asRecord(input);
  const queries = Array.isArray(record?.queries) ? record.queries : undefined;
  const firstQuery = queries
    ? asRecord(queries[0])?.query
    : record?.query;
  const query = typeof firstQuery === "string" ? JSON.stringify(safe(firstQuery, 80)) : undefined;
  const matches = matchedFiles(output);
  const where = matches === undefined
    ? ""
    : matches.files === 0
      ? " · no matches"
      : ` in ${matches.files} file${matches.files === 1 ? "" : "s"}${matches.truncated ? " · more remain" : ""}`;
  if (name === "search_many" && queries && queries.length > 1) {
    return `Searched ${queries.length} queries${query ? ` · ${query}` : ""}${where}`;
  }
  return `Searched ${query ?? "files"}${where}`;
};

const exploreItem = (name: string, input: unknown, output: unknown): ExploreItem => {
  if (name === "read_file") return { kind: "read", files: 1, line: readLine(input) };
  if (name === "read_files") {
    const files = asRecord(input)?.files;
    return { kind: "read", files: Array.isArray(files) ? files.length : 1, line: readFilesLine(input) };
  }
  if (name === "search_files" || name === "search_many") return { kind: "search", files: 0, line: searchLine(name, input, output) };
  if (name === "list_files") {
    const path = asRecord(input)?.path;
    return { kind: "list", files: 0, line: `Listed ${typeof path === "string" ? safe(path) : "."}` };
  }
  if (name === "read_dependency") {
    const record = asRecord(input);
    const pkg = record?.package ?? record?.name;
    return { kind: "read", files: 1, line: `Inspected ${typeof pkg === "string" ? safe(pkg, 80) : "a dependency"}` };
  }
  return { kind: "diff", files: 0, line: "Reviewed the git diff" };
};

const exploreSummary = (items: readonly ExploreItem[]) => {
  const reads = items.filter(item => item.kind === "read").reduce((sum, item) => sum + item.files, 0);
  const searches = items.filter(item => item.kind === "search").length;
  const listings = items.filter(item => item.kind === "list").length;
  const diffs = items.filter(item => item.kind === "diff").length;
  const parts: string[] = [];
  if (reads) parts.push(`${reads} file${reads === 1 ? "" : "s"}`);
  if (searches) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  if (listings) parts.push(`${listings} listing${listings === 1 ? "" : "s"}`);
  if (diffs) parts.push(`${diffs} diff${diffs === 1 ? "" : "s"}`);
  const sample = items[0]?.line ?? "activity";
  return `Explored ${parts.join(" · ") || `${items.length} steps`} · ${sample} · /activity`;
};

const otherLine = (name: string, input: unknown) => {
  const record = asRecord(input);
  if (name === "move_file" && typeof record?.source === "string" && typeof record.destination === "string") {
    return `Moved ${safe(record.source)} → ${safe(record.destination)}`;
  }
  if (name === "quarantine_file" && typeof record?.path === "string") return `Quarantined ${safe(record.path)}`;
  if (name === "restore_file" && typeof record?.destination === "string") return `Restored ${safe(record.destination)}`;
  if (name === "apply_environment_patch") return "Imported environment changes";
  if (name === "propose_edits") {
    const changes = Array.isArray(record?.changes) ? record.changes : [];
    const first = asRecord(changes[0])?.path;
    if (changes.length === 1 && typeof first === "string") return `Proposed edits for ${safe(first)}`;
    if (changes.length > 1) return `Proposed edits for ${changes.length} files`;
    return "Proposed edits";
  }
  if (!KNOWN_TOOLS.has(name) && !name.startsWith("verify_and_apply_")) return "Ran tool";
  return `Ran ${safe(name.replaceAll("_", " "), 40)}`;
};

/** Live transcript lines plus the history rows /activity expands. */
export class ActivityStream {
  private readonly calls = new Map<string, { name: string; input: unknown }>();
  private explore: ExploreItem[] = [];
  private edit: EditGroup | null = null;

  constructor(readonly diff: TurnDiff) {}

  noteCall(call: { id: string; name: string; input: unknown }): ActivityEmission[] {
    this.calls.set(call.id, { name: call.name, input: call.input });
    if (this.calls.size > 40) {
      const oldest = this.calls.keys().next().value;
      if (oldest) this.calls.delete(oldest);
    }
    if (isCheck(call.name)) return this.flushPending();
    if (EDIT_TOOLS.has(call.name)) {
      const path = editPath(call.name, call.input) || call.name;
      const flushed = this.edit && this.edit.path !== path ? this.flushEdit() : [];
      return [...this.flushExplore(), ...flushed];
    }
    if (EXPLORE_TOOLS.has(call.name)) return this.flushEdit();
    return this.flushPending();
  }

  noteResult(result: { toolCallId: string; toolName: string; isError?: boolean; error?: unknown; output?: unknown }): ActivityEmission[] {
    const call = this.calls.get(result.toolCallId);
    this.calls.delete(result.toolCallId);
    const name = result.toolName || call?.name || "tool";
    const input = call?.input;
    if (result.isError) {
      const line = compactToolResult({ toolName: name, isError: true, error: result.error })
        ?? "✗ Tool operation · operation failed. Inspect /activity and retry that file.";
      return [...this.flushPending(), emission(line)];
    }
    if (name.startsWith("verify_and_apply_")) {
      this.appendEdit(name, input);
      return this.flushPending();
    }
    if (isCheck(name)) return this.flushPending();
    if (EDIT_TOOLS.has(name)) {
      const path = editPath(name, input) || name;
      const flushed = this.edit && this.edit.path !== path ? this.flushEdit() : [];
      this.appendEdit(name, input);
      return [...this.flushExplore(), ...flushed];
    }
    if (EXPLORE_TOOLS.has(name)) {
      const flushed = this.flushEdit();
      this.explore.push(exploreItem(name, input, result.output));
      return flushed;
    }
    return [...this.flushPending(), emission(otherLine(name, input))];
  }

  flush(): ActivityEmission[] {
    return this.flushPending();
  }

  private flushPending(): ActivityEmission[] {
    return [...this.flushExplore(), ...this.flushEdit()];
  }

  private flushExplore(): ActivityEmission[] {
    if (!this.explore.length) return [];
    const items = this.explore;
    this.explore = [];
    if (items.length === 1) return [emission(items[0]?.line ?? "Read a file")];
    return [emission(exploreSummary(items), items.map(item => `  ${item.line}`))];
  }

  private flushEdit(): ActivityEmission[] {
    if (!this.edit) return [];
    const group = this.edit;
    this.edit = null;
    const stats = group.stats ? ` +${group.added} −${group.removed}` : "";
    const intent = group.intent ? `: ${group.intent}` : "";
    const attempts = group.attempts > 1 ? ` · ${group.attempts} attempts` : "";
    return [emission(`Edited ${editLabel(group.path)}${stats}${intent}${attempts}`, group.attempts > 1 ? group.details : [])];
  }

  private appendEdit(name: string, input: unknown) {
    const path = editPath(name, input) || name;
    if (!this.edit || this.edit.path !== path) {
      this.edit = { path, added: 0, removed: 0, attempts: 0, stats: true, details: [] };
    }
    const group = this.edit;
    const stats = name === "apply_reviewed_replacement" ? replacementStats(input) : undefined;
    const intent = stats?.intent ?? statedIntent(input);
    group.attempts += 1;
    if (!group.intent && intent) group.intent = intent;
    if (stats) {
      group.added += stats.added;
      group.removed += stats.removed;
      this.diff.added += stats.added;
      this.diff.removed += stats.removed;
      group.details.push(`  attempt ${group.attempts} +${stats.added} −${stats.removed}${intent ? `: ${intent}` : ""}`);
    } else {
      group.stats = false;
      group.details.push(`  attempt ${group.attempts}`);
    }
  }
}
