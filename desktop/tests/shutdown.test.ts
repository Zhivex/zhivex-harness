import { test, expect } from "bun:test";
import { prepareDesktopShutdown, type ShutdownRuntime } from "../src/shutdown.js";
const runtime = (busy = true, stops = true) => {
    const calls: string[] = [];
    const host: ShutdownRuntime = { async controlClose(operation) { calls.push(operation); if (operation === "cancel" && stops) busy = false; return operation === "pause" && busy; }, async close() { calls.push("close"); } };
    return { host, calls };
};
test("staying resumes every project without cancelling or closing", async () => {
    const a = runtime(), b = runtime(false); expect(await prepareDesktopShutdown([a.host, b.host], async () => "stay")).toBe(false);
    expect(a.calls).toEqual(["pause", "resume"]); expect(b.calls).toEqual(["pause", "resume"]);
});
test("explicit cancellation happens once and all hosts drain before close", async () => {
    const a = runtime(), b = runtime(); expect(await prepareDesktopShutdown([a.host, b.host], async () => "cancel")).toBe(true);
    expect(a.calls).toEqual(["pause", "cancel", "pause", "close"]); expect(b.calls).toEqual(a.calls);
});
test("unresponsive cancellation keeps hosts available without a forced close or retry", async () => {
    const a = runtime(true, false); await expect(prepareDesktopShutdown([a.host], async () => "cancel", 0)).rejects.toThrow("SHUTDOWN_STILL_BUSY");
    expect(a.calls).toEqual(["pause", "cancel", "pause", "resume"]);
});
test("unknown host state resumes other paused hosts and never authorizes shutdown", async () => {
    const a = runtime(false), b = runtime(); b.host.controlClose = async operation => { b.calls.push(operation); if (operation === "pause") throw new Error("offline"); return false; };
    await expect(prepareDesktopShutdown([a.host, b.host], async () => "cancel")).rejects.toThrow("SHUTDOWN_STATE_UNKNOWN");
    expect(a.calls).toEqual(["pause", "resume"]); expect(b.calls).toEqual(["pause", "resume"]);
});
