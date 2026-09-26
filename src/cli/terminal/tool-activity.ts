const labels: Readonly<Record<string, string>> = {
  read_file: "Reading a file", read_files: "Reading files", read_dependency: "Inspecting a dependency",
  search_files: "Searching files", search_many: "Searching the project", list_files: "Listing files",
  run_check: "Running checks", run_environment_command: "Running a command",
  apply_patch: "Applying edits", apply_reviewed_edits: "Applying reviewed edits",
  apply_reviewed_replacement: "Applying a reviewed replacement", git_diff: "Reviewing changes",
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
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private write: (text: string) => void, private tty: boolean,
    private columns: () => number = () => 80) {}

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
    const text = `… ${this.label}${elapsed ? ` · ${elapsed}s` : ""}${done ? ` · ${done} tools done` : ""}`;
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
  flush() {
    this.clear();
    if (this.completed.size) {
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

/** Render only fixed categories. Never echo paths, arguments, outputs, or arbitrary errors. */
export const compactToolResult = (result: { toolName: string; isError?: boolean; error?: unknown }): string | undefined => {
  if (!result.isError) return editLabels[result.toolName] ? `✓ ${editLabels[result.toolName]}` : undefined;
  const error = result.error && typeof result.error === "object" ? result.error as Record<string, unknown> : {};
  const message = typeof error.message === "string" ? error.message : "";
  let reason = "operation failed; inspect diagnostics for details";
  if (error.code === "TOOL_INPUT_VALIDATION_ERROR") reason = "invalid arguments; the assistant can correct and retry";
  else if (error.code === "ENOENT" || /^ENOENT: /.test(message)) reason = "file not found; list files to locate the correct path";
  else if ((message.startsWith("Dependency package or path was not found in ") || message.startsWith("Dependency path was not found in "))) reason = "dependency path not found; list the package files before retrying";
  else if (message.startsWith("Dependency ") && message.includes(" is not installed in this workspace\'s node_modules.")) reason = "dependency not installed; check the project installation";
  else if (message.startsWith("Dependency paths must be package-relative;")) reason = "dependency path is outside the permitted boundary; use a package-relative path";
  else if (/^The path is protected by the harness policy: node_modules(?:\/|$)/.test(message)) reason = "dependency access requires the dependency tools";
  else if (/^The path is protected by the harness policy: /.test(message)) reason = "path protected by workspace policy";
  else if (message === "Dependency access only permits package.json and TypeScript declaration files.") reason = "dependency file type is not permitted";
  else if (message === "Dependency directory links are not allowed.") reason = "dependency link is outside the permitted boundary";
  else if (message.startsWith("Dependency directory changed during inspection.")) reason = "dependency changed during inspection; retry the read";
  const operation = labels[result.toolName] ?? "Tool operation";
  return `✗ ${operation} · ${reason}`;
};
