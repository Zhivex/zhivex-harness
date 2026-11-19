import type { Writable } from "node:stream";
import type { AgentStreamEvent } from "@zhivex-ai/agents";
import { consoleLabel, consoleStateLines, consoleWidth, type ConsoleComposerInput } from "./console-presentation.js";

/** Reserve a small status dock while the conversation scrolls above it. */
export class ConsoleRunView {
  private timer: ReturnType<typeof setInterval> | undefined;
  private bottom = 0;
  private started = 0;
  private phase = "Waiting for model response";
  private step = 0;
  constructor(private readonly output: Writable & { isTTY?: boolean; rows?: number; columns?: number },
    private readonly state: () => ConsoleComposerInput, private readonly draft: () => string) {}

  begin(phase = "Waiting for model response") {
    if (this.timer) return;
    this.started = Date.now();
    this.phase = phase;
    this.step = 0;
    this.resume();
  }
  /** Restore the dock after approval without restarting the current operation. */
  resume() {
    if (this.timer || !this.output.isTTY || process.env.TERM === "dumb" || (this.output.rows ?? 24) < 18 || (this.output.columns ?? 80) < 32) return;
    this.layout();
    this.output.on("resize", this.resize);
    this.timer = setInterval(() => this.draw(), 250);
    this.timer.unref();
  }
  private lines() {
    const width = consoleWidth(this.output.columns);
    return ["─".repeat(width), ...consoleStateLines(this.state(), this.output.columns),
      consoleLabel(`${this.phase} · ${Math.floor((Date.now() - this.started) / 1000)}s · step ${this.step}`, width),
      consoleLabel(this.draft(), width), consoleLabel("Ctrl+C stop · Enter queues · /activity later", width)];
  }
  private layout() {
    this.bottom = Math.max(3, (this.output.rows ?? 24) - this.lines().length);
    this.output.write(`\x1b[1;${this.bottom}r\x1b[${this.bottom};1H`);
    this.draw();
  }
  private readonly resize = () => {
    if ((this.output.rows ?? 24) < 18 || (this.output.columns ?? 80) < 32) { this.end(); return; }
    this.output.write("\x1b[r"); this.layout();
  };
  private draw() {
    if (!this.bottom) return;
    this.output.write("\x1b7" + this.lines().map((line, index) =>
      `\x1b[${this.bottom + index + 1};1H\x1b[2K${line}`).join("") + "\x1b8");
  }
  observe(event: AgentStreamEvent) {
    if (event.type === "agent-step-start") { this.step = event.stepIndex + 1; this.phase = "Waiting for model response"; }
    else if (event.type === "text-delta") this.phase = "Receiving response";
    else if (event.type === "tool-call") this.phase = "Running action";
    else if (event.type === "agent-compaction") this.phase = "Updating context";
    else if (event.type === "tool-approval-request" || event.type === "agent-approval-request") this.phase = "Approval pending";
    else if (event.type === "tool-result") this.phase = event.toolResult.isError ? "Action failed · inspect result above" : "Action returned";
    this.draw();
  }
  end() {
    if (!this.bottom) return;
    clearInterval(this.timer); this.timer = undefined;
    this.output.off("resize", this.resize);
    this.output.write(`\x1b[r\x1b[${this.bottom + 1};1H\x1b[J`);
    this.bottom = 0;
  }
}
