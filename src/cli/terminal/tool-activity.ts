const labels: Readonly<Record<string, string>> = {
  read_file: "Reading a file", read_files: "Reading files", read_dependency: "Inspecting dependency types",
  search_files: "Searching files", search_many: "Searching the project", list_files: "Listing files",
  run_check: "Running checks", run_environment_command: "Running a command",
  apply_patch: "Applying edits", apply_reviewed_edits: "Applying reviewed edits",
  apply_reviewed_replacement: "Applying a reviewed replacement", git_diff: "Reviewing changes",
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

  phase(label: "Waiting for model response" | "Waiting for approval", step?: number) {
    this.flush();
    this.label = `${label}${step === undefined ? "" : ` · step ${step}`}`;
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
    if (success && !["run_check", "run_environment_command"].includes(name) && !name.startsWith("verify_and_apply_")) {
      const label = labels[name] ?? "Running a tool";
      this.completed.set(label, (this.completed.get(label) ?? 0) + 1);
    }
    this.label = this.active ? this.label : "Waiting for model response";
    this.begin();
  }
  private begin() {
    this.started = Date.now();
    this.render();
    if (this.tty && !this.timer) {
      this.timer = setInterval(() => this.render(), 1_000);
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
  flush() {
    clearInterval(this.timer); this.timer = undefined;
    if (this.visible) this.write("\r\x1b[2K");
    this.visible = false;
    for (const [label, count] of this.completed) {
      this.write(`✓ ${label} · ${count} completed\n`);
    }
    this.completed.clear();
  }
}
