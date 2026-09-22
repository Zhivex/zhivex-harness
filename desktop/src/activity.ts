import type { HarnessActivityPage, HarnessActivityRun } from "../../src/internal/desktop/protocol.js";
export interface ConversationActivity { cursor: number; runs: Record<string, HarnessActivityRun>; order: string[]; recovered: boolean }
export const emptyActivity = (): ConversationActivity => ({ cursor: 0, runs: {}, order: [], recovered: false });
/** Cursor and contents commit together. Replayed pages never append the same delta twice. */
export function applyActivityPage(previous: ConversationActivity, page: HarnessActivityPage): ConversationActivity {
    if (page.nextCursor < previous.cursor) return previous;
    if (page.cursorExpired) { if (!page.snapshot) throw new Error("SNAPSHOT_REQUIRED"); return { cursor: page.nextCursor, runs: structuredClone(page.snapshot.runs), order: Object.keys(page.snapshot.runs), recovered: true }; }
    if (!page.cursorExpired && page.nextCursor === previous.cursor && page.events.every(event => event.sequence <= previous.cursor)) return previous;
    const next = structuredClone(previous);
    for (const event of page.events) {
        if (event.sequence <= previous.cursor) continue;
        if (!Object.hasOwn(next.runs, event.runId)) { next.runs[event.runId] = { text: "", status: "running", truncated: false }; next.order.push(event.runId); }
        const run = next.runs[event.runId]!, a = event.activity;
        if (typeof a.textDelta === "string") { run.text += a.textDelta; if (run.text.length > 262144) { run.text = run.text.slice(-262144); run.truncated = true; } }
        if (a.type === "user-message" && typeof a.prompt === "string") run.prompt = a.prompt;
        if (typeof a.status === "string" && ["checkpoint", "agent-run-finish"].includes(String(a.type))) run.status = a.status;
        if (a.type === "agent-run-start") run.status = "running";
        if (a.type === "tool-approval-request" || a.type === "agent-approval-request") run.status = "waiting_approval";
        if (typeof a.toolCallId === "string" && typeof a.toolName === "string") {
            run.tools ??= {}; const id = `tool:${a.toolCallId}`;
            if (run.tools[id] || Object.keys(run.tools).length < 256) run.tools[id] = { name: a.toolName, status: a.type === "tool-result" ? (a.isError === true || a.timedOut === true || typeof a.exitCode === "number" && a.exitCode !== 0 ? "failed" : "completed") : "running", ...(typeof a.exitCode === "number" ? { exitCode: a.exitCode } : {}), ...(typeof a.timedOut === "boolean" ? { timedOut: a.timedOut } : {}) };
            else run.truncated = true;
        }
    }
    next.cursor = page.nextCursor; return next;
}
