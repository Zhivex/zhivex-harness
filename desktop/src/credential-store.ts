import { rememberSensitiveValue } from "./redaction.js";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
const statusSchema = z.enum(["present", "missing", "saved", "deleted", "cancelled", "locked", "unavailable", "invalid", "unsupported"]);
export type CredentialStatus = z.infer<typeof statusSchema>;
export type CredentialProbe = CredentialStatus | "connected" | "invalid-credential" | "forbidden" | "rate-limited" | "network-error";
type Action = "status" | "configure" | "read" | "delete";
const responseSchema = z.object({ status: statusSchema, secret: z.string().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/).optional() }).strict();
/** Host-only. Never expose read() or helper stdout through the renderer bridge. */
export function openCredentialStore(helper: string, options: { platform?: string; request?: typeof fetch; timeoutMs?: number } = {}) {
    const supported = (options.platform ?? process.platform) === "darwin";
    if (!path.isAbsolute(helper)) throw new Error("CREDENTIAL_HELPER_PATH");
    let queue = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>) => { const result = queue.then(fn); queue = result.then(() => { }, () => { }); return result; };
    const invoke = async (action: Action): Promise<z.infer<typeof responseSchema>> => {
        if (!supported) return { status: "unsupported" };
        return new Promise(resolve => {
            let child: ReturnType<typeof spawn>; try { child = spawn(helper, [action], { cwd: os.tmpdir(), env: { PATH: "/usr/bin:/bin", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }, stdio: ["ignore", "pipe", "ignore"] }); } catch { return resolve({ status: "unavailable" }); }
            let chunks: Buffer[] = [], bytes = 0, done = false;
            const finish = (result: z.infer<typeof responseSchema>) => { if (done) return; done = true; clearTimeout(timer); chunks = []; resolve(result); };
            const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ status: "unavailable" }); }, options.timeoutMs ?? (action === "configure" ? 120000 : 10000));
            child.stdout?.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384) { child.kill("SIGKILL"); finish({ status: "unavailable" }); } else chunks.push(chunk); });
            child.once("error", () => finish({ status: "unavailable" }));
            child.once("close", code => { if (done) return; try { if (code !== 0) throw new Error(); const value = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); if ((action !== "read" && value.secret !== undefined) || (action === "read" && (value.status === "present") !== (value.secret !== undefined))) throw new Error(); if (value.secret) rememberSensitiveValue(value.secret); finish(value); } catch { finish({ status: "unavailable" }); } });
        });
    };
    return {
        status: () => serial(async () => (await invoke("status")).status),
        configure: () => serial(async () => { const result = await invoke("configure"); if (result.status === "saved") await invoke("read"); return result.status; }),
        delete: () => serial(async () => (await invoke("delete")).status),
        read: () => serial(() => invoke("read")),
        probe: (): Promise<CredentialProbe> => serial(async () => {
            const value = await invoke("read"); if (value.status !== "present" || !value.secret) return value.status;
            try { const response = await (options.request ?? fetch)("https://api.openai.com/v1/models", { method: "GET", headers: { Authorization: `Bearer ${value.secret}` }, redirect: "error", signal: AbortSignal.timeout(10000) }); void response.body?.cancel().catch(() => { }); return response.status === 200 ? "connected" : response.status === 401 ? "invalid-credential" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate-limited" : "network-error"; } catch { return "network-error"; }
        })
    };
}
