import type { AgentStreamEvent } from "@zhivex-ai/agents";
import { WebLimitStore } from "./limit-store.js";
import { reachedLimits, type RunLimits, type LimitPricing } from "./limit-observer.js";
export type { LimitPricing } from "./limit-observer.js";

/** One service owner, one active invocation. Never reserves money or changes engine policy. */
export class WebLimitMonitor {
  private runs = new Map<string, RunLimits>();
  private active: { run: RunLimits; since: number; previousMinutes: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private store: WebLimitStore, private cancel: () => Promise<void>, private price: LimitPricing | null, private now = Date.now, private hostDigest?: string) {}
  private enqueue(job: () => Promise<void>) {
    const next = this.serial.then(job);
    this.serial = next.catch(() => {});
    return next;
  }
  async admitted(sessionId: string, runId: string) {
    const snapshot = await this.store.admit();
    const run: RunLimits = { runId, sessionId, ...snapshot, startedAt: this.now(), status: "created",
      ...(this.hostDigest ? { hostConfigDigest: this.hostDigest } : {}),
      consumption: { costUsd: null, tokens: 0, steps: 0, toolCalls: 0, durationMinutes: 0 }, notices: [], cancellationRequested: false,
      reportedUsage: { inputTokens: 0, outputTokens: 0, complete: true, lastStep: 0 }, toolReceipts: [], pricing: this.price };
    // Inactive snapshots remain durable; memory is bounded independently of usage.
    if (this.runs.size >= 64) for (const [id, previous] of this.runs) {
      if (previous !== this.active?.run && !previous.observationError) { this.runs.delete(id); break; }
    }
    this.runs.set(runId, run);
    await this.store.saveRun(run);
  }
  private async evaluate(run: RunLimits) {
    if (this.active?.run === run) run.consumption.durationMinutes = this.active.previousMinutes + (this.now() - this.active.since) / 60_000;
    const reached = reachedLimits(run, this.now());
    run.notices.push(...reached);
    const stop = reached.some(n => n.action === "stop") && !run.cancellationRequested && run.status === "running";
    if (stop) run.cancellationRequested = true;
    await this.store.saveRun(run);
    // Persist the reason first. Existing cancellation retains durable effects.
    if (stop && this.active?.run === run) await this.cancel();
  }
  event(sessionId: string, runId: string, event: AgentStreamEvent) {
    return this.enqueue(async () => {
      let run = this.runs.get(runId);
      if (!run) { run = await this.store.readRun(runId) ?? undefined; if (run) this.runs.set(runId, run); }
      if (!run || run.sessionId !== sessionId) return; // Legacy run owns its original policy.
      if (event.type === "agent-run-start") {
        run.status = "running";
        this.active = { run, since: this.now(), previousMinutes: run.consumption.durationMinutes };
        clearInterval(this.timer);
        this.timer = setInterval(() => void this.enqueue(async () => {
          if (this.active?.run === run) await this.evaluate(run);
        }).catch(() => this.failed(run!.runId)), 250);
      } else if (event.type === "tool-result") {
        if (run.toolReceipts.includes(event.toolResult.toolCallId)) return;
        run.toolReceipts.push(event.toolResult.toolCallId);
        run.consumption.toolCalls++;
      } else if (event.type === "agent-step-finish") {
        run.consumption.steps = Math.max(run.consumption.steps, event.step.index);
        if (event.step.index > run.reportedUsage.lastStep) {
          run.reportedUsage.lastStep = event.step.index;
          const usage = event.step.response?.usage;
          if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined ||
            (run.pricing?.maxInputTokens !== undefined && usage.inputTokens > run.pricing.maxInputTokens)) run.reportedUsage.complete = false;
          run.reportedUsage.inputTokens += usage?.inputTokens ?? 0;
          run.reportedUsage.outputTokens += usage?.outputTokens ?? 0;
          run.consumption.tokens += Math.max(usage?.totalTokens ?? 0, (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
          const price = run.pricing;
          const input = run.reportedUsage.inputTokens, output = run.reportedUsage.outputTokens;
          run.consumption.costUsd = price && run.reportedUsage.complete
            ? (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000 : null;
        }
      } else if (event.type === "agent-run-finish") {
        run.status = event.state.status;
        run.consumption.tokens = Math.max(run.consumption.tokens, event.state.usage?.totalTokens ??
          (event.state.usage?.inputTokens ?? 0) + (event.state.usage?.outputTokens ?? 0));
        // Auxiliary model usage is included only when the SDK supplies a complete cumulative receipt.
        const usage = event.state.usage;
        if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined &&
          (usage.inputTokens !== run.reportedUsage.inputTokens || usage.outputTokens !== run.reportedUsage.outputTokens)) {
          run.consumption.costUsd = null; // A tier/cached utility receipt cannot be reconstructed from totals.
        }
        await this.evaluate(run);
        this.stopTimer(run);
        return;
      } else return;
      await this.evaluate(run);
    });
  }
  checkpoint(sessionId: string, runId: string, status: string) {
    return this.enqueue(async () => {
      const run = this.runs.get(runId);
      if (!run || run.sessionId !== sessionId) return;
      run.status = status;
      await this.evaluate(run);
      this.stopTimer(run);
    });
  }
  private stopTimer(run: RunLimits) { if (this.active?.run === run) { clearInterval(this.timer); this.active = undefined; } }
  snapshot(runId: string) { return this.runs.get(runId); }
  async failed(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.observationError = true;
    if (this.active?.run === run && !run.cancellationRequested && Object.values(run.settings).some(t => t.value !== null && t.action === "stop")) {
      run.cancellationRequested = true;
      await this.cancel().catch(() => {});
    }
  }
  async close() { clearInterval(this.timer); this.active = undefined; await this.serial; }
}
