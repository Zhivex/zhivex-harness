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

test("stay is offered before waiting for IPC blocked on an active run", async () => {
    const a = runtime(); let drained = false;
    expect(await prepareDesktopShutdown([a.host], async () => "stay", 5000, async () => { drained = true; })).toBe(false);
    expect(drained).toBe(false); expect(a.calls).toEqual(["pause", "resume"]);
});

test("cancel releases the run before accepted IPC drains and hosts close", async () => {
    const a = runtime();
    expect(await prepareDesktopShutdown([a.host], async () => "cancel", 5000, async () => {
        expect(a.calls).toEqual(["pause", "cancel", "pause"]); a.calls.push("drain");
    })).toBe(true);
    expect(a.calls).toEqual(["pause", "cancel", "pause", "drain", "close"]);
});

test("failed accepted-work drain resumes paused hosts instead of closing them", async () => {
    const a = runtime(false);
    await expect(prepareDesktopShutdown([a.host], async () => "cancel", 5000, async () => { throw new Error("drain failed"); })).rejects.toThrow("drain failed");
    expect(a.calls).toEqual(["pause", "resume"]);
});

test("shutdown waits for an accepted model replacement and closes its new owner", async () => {
    const replacement = runtime(false);
    const hosts: ShutdownRuntime[] = [];
    let finishSwitch!: () => void;
    const switching = new Promise<void>(resolve => { finishSwitch = resolve; });
    let draining!: () => void;
    const drainStarted = new Promise<void>(resolve => { draining = resolve; });
    const shutdown = prepareDesktopShutdown([...hosts], async () => "cancel", 5000,
        async () => { draining(); await switching; }, async () => [...hosts]);
    await drainStarted;
    // select-model has removed the old runtime and is still launching its successor.
    hosts.push(replacement.host);
    finishSwitch();
    expect(await shutdown).toBe(true);
    expect(replacement.calls).toEqual(["pause", "close"]);
});

test("a retained host is not cancelled or closed twice after refreshing owners", async () => {
    const a = runtime(), replacement = runtime(false);
    expect(await prepareDesktopShutdown([a.host], async () => "cancel", 5000,
        async () => {}, async () => [a.host, replacement.host])).toBe(true);
    expect(a.calls).toEqual(["pause", "cancel", "pause", "close"]);
    expect(replacement.calls).toEqual(["pause", "close"]);
});

test("staying for a newly discovered busy owner resumes all hosts", async () => {
    const a = runtime(false), replacement = runtime();
    expect(await prepareDesktopShutdown([a.host], async () => "stay", 5000,
        async () => {}, async () => [replacement.host])).toBe(false);
    expect(a.calls).toEqual(["pause", "resume"]);
    expect(replacement.calls).toEqual(["pause", "resume"]);
});

test("explicit cancellation also drains a newly discovered owner without repeating the choice", async () => {
    const a = runtime(), replacement = runtime();
    let choices = 0;
    expect(await prepareDesktopShutdown([a.host], async () => { choices++; return "cancel"; }, 5000,
        async () => {}, async () => [replacement.host])).toBe(true);
    expect(choices).toBe(1);
    expect(a.calls).toEqual(["pause", "cancel", "pause", "close"]);
    expect(replacement.calls).toEqual(["pause", "cancel", "pause", "close"]);
});

test("a replacement with unknown state prevents shutdown and resumes all hosts", async () => {
    const a = runtime(false), replacement = runtime(false);
    replacement.host.controlClose = async operation => {
        replacement.calls.push(operation);
        if (operation === "pause") throw new Error("offline");
        return false;
    };
    await expect(prepareDesktopShutdown([a.host], async () => "cancel", 5000,
        async () => {}, async () => [replacement.host])).rejects.toThrow("SHUTDOWN_STATE_UNKNOWN");
    expect(a.calls).toEqual(["pause", "resume"]);
    expect(replacement.calls).toEqual(["pause", "resume"]);
});
