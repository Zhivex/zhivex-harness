import { createRedactionPolicy } from "@zhivex-ai/agents";
import { sanitizeTerminalText } from "./terminal-ui.js";

const failureRedaction = createRedactionPolicy({ includeEmails: true });

const labels: Readonly<Record<string, string>> = {
  read_file: "Reading a file", read_files: "Reading files", read_dependency: "Inspecting a dependency",
  search_files: "Searching files", search_many: "Searching the project", list_files: "Listing files",
  run_check: "Running checks", run_environment_command: "Running a command",
  apply_patch: "Preparing edits", apply_reviewed_edits: "Preparing reviewed edits",
  apply_reviewed_replacement: "Preparing a reviewed replacement", git_diff: "Reviewing changes",
};

const summaries: Readonly<Record<string, string>> = {
  read_file: "reads", read_files: "reads", read_dependency: "dependency inspections",
  search_files: "searches", search_many: "searches",
  list_files: "listings",
  git_diff: "diffs",
};

/** Live progress plus a bounded, durable summary per activity group. No tool payloads. */
export class ToolActivity {
  private active = 0;
  private visible = false;
  private label = "Working";
  private completed = new Map<string, number>();
  private started = Date.now();
  private readonly runStarted = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private write: (text: string) => void, private tty: boolean,
    private columns: () => number = () => 80,
    private inputStatus: () => string = () => "") {}

  phase(label: "Waiting for model response" | "Waiting for approval" | "Updating context", _step?: number) {
    this.clear();
    this.label = label;
    this.begin();
  }
  start(name?: string) {
    this.active++;
    this.label = labels[name ?? ""] ?? "Running a tool";
    this.begin();
  }
  finish(name: string, success = true) {
    this.active = Math.max(0, this.active - 1);
    // Checks and failures have their own authoritative receipt in the transcript.
    if (success && !["run_check", "run_environment_command"].includes(name) && !name.startsWith("verify_and_apply_") && !editLabels[name]) {
      const label = summaries[name] ?? "other operations";
      this.completed.set(label, (this.completed.get(label) ?? 0) + 1);
    }
    this.label = this.active ? this.label : "Waiting for model response";
    this.begin();
  }
  private begin() {
    this.started = Date.now();
    this.render();
    if (this.tty && !this.timer) {
      // A timer can fire just before a whole second; refresh before the next second.
      this.timer = setInterval(() => this.render(), 250);
      this.timer.unref();
    }
  }
  private render() {
    if (!this.tty) return;
    const elapsed = Math.floor((Date.now() - this.started) / 1_000);
    const done = [...this.completed.values()].reduce((sum, count) => sum + count, 0);
    const total = Math.floor((Date.now() - this.runStarted) / 1_000);
    const input = this.inputStatus();
    const timing = `${elapsed}s phase · ${total}s total`;
    const text = input.includes("draft:") || !input.startsWith("0 queued") && input
      ? `… ${input} · ${timing}`
      : `… ${this.label} · ${timing}${done ? ` · ${done} tools done` : ""}`;
    this.write(`\r\x1b[2K${Array.from(text).slice(0, Math.max(1, this.columns() - 1)).join("")}`);
    this.visible = true;
  }
  /** Hide progress while prose or a receipt is printed, preserving the cumulative counts. */
  pause() { this.clear(); }
  private clear() {
    clearInterval(this.timer); this.timer = undefined;
    if (this.visible) this.write("\r\x1b[2K");
    this.visible = false;
  }
  flush(options?: { summary?: boolean }) {
    this.clear();
    if (options?.summary && this.completed.size) {
      const details = [...this.completed].map(([label, count]) => `${label}: ${count}`).join(" · ");
      this.write(`✓ Activity · ${details}\n`);
    }
    this.completed.clear();
  }
}

const editLabels: Readonly<Record<string, string>> = {
  apply_patch: "Edits applied", apply_reviewed_edits: "Reviewed edits applied",
  apply_reviewed_replacement: "Reviewed replacement applied", apply_environment_patch: "Environment changes imported",
};

const SAFE_CAUSE = /^(?:file is binary after edit:|Refusing to write a control byte|Stale patch|Replacement requires|Preview requires|The patch |oldText |Content exceeds|proposalId does not match)/;

const clipCause = (message: string) =>
  failureRedaction.redactText(sanitizeTerminalText(message)).replace(/\s+/g, " ").trim().slice(0, 240);

/** Failures name a safe cause and the next step. Successful edits are grouped by the activity stream. */
export const compactToolResult = (result: { toolName: string; isError?: boolean; error?: unknown }): string | undefined => {
  if (!result.isError) return undefined;
  const error = result.error && typeof result.error === "object" ? result.error as Record<string, unknown> : {};
  const message = typeof error.message === "string" ? error.message : "";
  const binaryRead = /^The file appears to be binary and cannot be read as text(?:: ([^.]+))?/.exec(message);
  let reason = "operation failed. Inspect /activity and retry that file.";
  if (message === "Denied by the operator."
    || message === "Computer action was denied by the approval policy."
    || /^Tool ".+" was denied by the approval policy\.$/.test(message)) reason = "rejected by you";
  else if (binaryRead) reason = `file is binary${binaryRead[1] ? `: ${binaryRead[1]}` : ""}. Restore the text version, then read it again.`;
  else if (error.code === "TOOL_INPUT_VALIDATION_ERROR") reason = "invalid arguments; the assistant can correct and retry";
  else if (error.code === "ENOENT" || /^ENOENT: /.test(message)) reason = "file not found; list files to locate the correct path";
  else if ((message.startsWith("Dependency package or path was not found in ") || message.startsWith("Dependency path was not found in "))) reason = "dependency path not found; list the package files before retrying";
  else if (message.startsWith("Dependency ") && message.includes(" is not installed in this workspace\'s node_modules.")) reason = "dependency not installed; check the project installation";
  else if (message.startsWith("Dependency paths must be package-relative;")) reason = "dependency path is outside the permitted boundary; use a package-relative path";
  else if (/^The path is protected by the harness policy: node_modules(?:\/|$)/.test(message)) reason = "dependency access requires the dependency tools";
  else if (/^The path is protected by the harness policy: /.test(message)) reason = "path protected by workspace policy";
  else if (message === "Dependency access only permits package.json and TypeScript declaration files.") reason = "dependency file type is not permitted";
  else if (message === "Dependency directory links are not allowed.") reason = "dependency link is outside the permitted boundary";
  else if (message.startsWith("Dependency directory changed during inspection.")) reason = "dependency changed during inspection; retry the read";
  else if (SAFE_CAUSE.test(message)) {
    reason = clipCause(message);
    if (!/not changed|reverted|retry|Read the file/i.test(reason)) reason += " Read the file again before retrying.";
  }
  const operation = labels[result.toolName] ?? "Tool operation";
  return `✗ ${operation} · ${reason}${editLabels[result.toolName] && error.code === "TOOL_INPUT_VALIDATION_ERROR" ? " · edits not applied" : ""}`;
};
