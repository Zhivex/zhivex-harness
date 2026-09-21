export interface ShutdownRuntime {
    controlClose(operation: "pause" | "resume" | "cancel"): Promise<boolean>;
    close(): Promise<void>;
}
/** Keep the window until all hosts stop accepting mutations and drain safely. */
export async function prepareDesktopShutdown(runtimes: ShutdownRuntime[], choose: () => Promise<"stay" | "cancel">, timeoutMs = 5000): Promise<boolean> {
    let completed = false;
    try {
        const pauses = await Promise.allSettled(runtimes.map(runtime => runtime.controlClose("pause")));
        if (pauses.some(result => result.status === "rejected")) throw new Error("SHUTDOWN_STATE_UNKNOWN");
        const busy = pauses.some(result => result.status === "fulfilled" && result.value);
        if (busy) {
            if (await choose() === "stay") return false;
            // One explicit cancellation per host; repeated checks below are reads only.
            const cancellations = await Promise.allSettled(runtimes.map(runtime => runtime.controlClose("cancel")));
            if (cancellations.some(result => result.status === "rejected")) throw new Error("SHUTDOWN_CANCELLATION_UNCONFIRMED");
            const deadline = Date.now() + timeoutMs;
            while ((await Promise.all(runtimes.map(runtime => runtime.controlClose("pause")))).some(Boolean)) {
                if (Date.now() >= deadline) throw new Error("SHUTDOWN_STILL_BUSY");
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        await Promise.all(runtimes.map(runtime => runtime.close())); completed = true; return true;
    } finally { if (!completed) await Promise.allSettled(runtimes.map(runtime => runtime.controlClose("resume"))); }
}
