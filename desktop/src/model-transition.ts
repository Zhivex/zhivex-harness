import type { DesktopModelSelection } from "./bridge.js";
import type { HarnessClientResponse } from "../../src/client-contract.js";
interface Host {
    isAlive(): boolean;
    controlClose(action: "pause" | "resume"): Promise<boolean>;
    command(command: Record<string, unknown>): Promise<HarnessClientResponse>;
    close(): Promise<void>;
}
/** Reject changing a runtime that owns unfinished work, including a durable approval. */
export async function prepareModelTransition(host: Host): Promise<void> {
    if (!host.isAlive()) throw new Error("MODEL_STATE_UNAVAILABLE");
    try {
        if (await host.controlClose("pause")) throw new Error("MODEL_WORK_ACTIVE");
        const response = await host.command({method: "session.list"});
        if (!response.ok || response.data.kind !== "sessions") throw new Error("MODEL_STATE_UNAVAILABLE");
        if (response.data.sessions.some(s => s.runs.some(r => !["completed", "failed", "cancelled", "timed_out"].includes(r.status)))) throw new Error("MODEL_WORK_ACTIVE");
    } catch (error) {
        if (host.isAlive()) await host.controlClose("resume");
        throw error;
    }
}
export const sameModel = (a: DesktopModelSelection, b: DesktopModelSelection) => a.provider === b.provider && a.model === b.model;
