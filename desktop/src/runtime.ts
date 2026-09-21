import {protectPersistenceSecret} from "../../src/persistence-secrets.js";
import {resolveHarnessConfig,createProviderModel} from "../../src/config.js";
import { fixtureOciRuntime } from "./fixture-oci.js";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { hostSensitiveValues } from "./redaction.js";
import { createHarness } from "../../src/harness.js";
import { startHarnessLocalService, recoverHarnessLocalService } from "../../src/local-service.js";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
import type { LanguageModel } from "@zhivex-ai/agents";

const parent = (process as NodeJS.Process & { parentPort: { postMessage(value: unknown): void; on(event: "message", listener: (event: { data: unknown }) => void): void } }).parentPort;
async function boot() {
    const config = JSON.parse(process.argv[2]!) as { workspace: string; directory: string; fixture: boolean; fixtureOci?: boolean; fixtureEffectCrash?: boolean; stateDirectory?: string; recover: boolean };
    const bootstrap=await new Promise<{secret?:string}>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("BOOTSTRAP_TIMEOUT")),10000);parent.on("message",event=>{const value=event.data;if(!value||typeof value!=="object"||!("kind" in value)||value.kind!=="credential-bootstrap")return;clearTimeout(timer);if(Object.keys(value).some(k=>!["kind","secret"].includes(k))||("secret" in value&&(typeof value.secret!=="string"||!value.secret||value.secret.length>8192)))return reject(new Error("BOOTSTRAP_INVALID"));resolve(value as {secret?:string});});});
 const providerEnv={...(bootstrap.secret?{OPENAI_API_KEY:bootstrap.secret}:{})};
 if(bootstrap.secret)protectPersistenceSecret(bootstrap.secret);
 const base = createMockLanguageModel();
    const mock: LanguageModel = {
        ...base, async stream(input) {
            return (async function* () {
                const userIndex = input.messages.findLastIndex(m => m.role === "user"); const prompt = JSON.stringify(input.messages[userIndex] ?? {});
                const probe = prompt.includes("activity-probe");
                const hasResult = input.messages.slice(userIndex + 1).some(m => m.role === "tool");
                if (prompt.includes("oci-review-probe") && !hasResult) {
                    yield { type: "tool-call" as const, toolCall: { id: `oci-edit-${userIndex}`, name: "verify_and_apply_reviewed_edits", input: { changes: [{ path: "review.txt", expectedDigest: "sha256:" + createHash("sha256").update("before\n").digest("hex"), content: "verified after\n" }], command: "node", args: ["-e", "process.exit(0)"] } } };
                    yield { type: "finish" as const, finishReason: "tool-calls" as const }; return;
                }
                if (prompt.includes("file-review-probe") && !hasResult) {
                    yield { type: "tool-call" as const, toolCall: { id: `review-edit-${userIndex}`, name: "apply_reviewed_replacement", input: { path: "review.txt", expectedDigest: "sha256:" + createHash("sha256").update("context\r\nbefore\r\nlast").digest("hex"), oldText: "before", newText: "after <img onerror=alert(1)>" } } };
                    yield { type: "finish" as const, finishReason: "tool-calls" as const }; return;
                }
                if (probe && !hasResult) {
                    yield { type: "tool-call" as const, toolCall: { id: "probe-read", name: "read_file", input: { path: "package.json" } } };
                    yield { type: "tool-call" as const, toolCall: { id: "probe-check", name: "run_check", input: { check: "test", expectedScript: "bun -e 'process.exit(7)'" } } };
                    yield { type: "finish" as const, finishReason: "tool-calls" as const }; return;
                }
                yield { type: "text-delta" as const, textDelta: "Runtime separado: SQLite y streaming disponibles. " };
                if (prompt.includes("wait-for-cancel")) await new Promise<void>(resolve => { if (input.abortSignal?.aborted) resolve(); else input.abortSignal?.addEventListener("abort", () => resolve(), { once: true }); });
                if (probe) {
                    const secret = process.env.ZHIVEX_HARNESS_DESKTOP_FIXTURE_SECRET ?? "fixture-secret";
                    yield { type: "text-delta" as const, textDelta: "Contenido literal <img src=x onerror=alert(1)> " };
                    yield { type: "text-delta" as const, textDelta: secret.slice(0, 8) }; yield { type: "text-delta" as const, textDelta: secret.slice(8) + " " };
                    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 25)); yield { type: "text-delta" as const, textDelta: `parte-${i} ` }; }
                }
                yield { type: "finish" as const, finishReason: "stop" as const };
            })();
        }
    };
    let fixtureClockOffset = 0;
    const harness = await createHarness({env:{},storeBackend:"sqlite", workspace: config.workspace, ...(config.stateDirectory ? { stateDirectory: config.stateDirectory } : {}), provider: "openai", modelInstance:config.fixture?mock:createProviderModel(resolveHarnessConfig({workspace:config.workspace,provider:"openai",storeBackend:"sqlite"}),providerEnv), subagentProfiles: [], ...(config.fixture && config.fixtureOci ? { executionBackend: "oci", ociAllowedCommands: ["node", "bun"], ociRuntimeAdapter: fixtureOciRuntime() } : {}) });
    try {
        if (config.recover) try { await recoverHarnessLocalService(harness, config.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const service = await startHarnessLocalService(harness, { directory: config.directory, sensitiveValues: [...hostSensitiveValues(process.env),...(bootstrap.secret?[bootstrap.secret]:[])], ...(config.fixture ? { maxEvents: 8, approvalNow: () => Date.now() + fixtureClockOffset } : {}) });
        if (config.fixture && config.fixtureEffectCrash) {
            const complete = harness.store.completeToolExecution!.bind(harness.store);
            harness.store.completeToolExecution = async (entry, options) => {
                if (entry.toolName === "apply_reviewed_replacement" && entry.status === "completed") {
                    // The real tool already returned after writing; no journal completion is saved.
                    writeFileSync(path.join(config.directory, "effect-crash.json"), JSON.stringify({ runId: entry.runId, toolName: entry.toolName, pid: process.pid, beforeJournalCommit: true }), { mode: 0o600 });
                    process.kill(process.pid, "SIGKILL"); await new Promise<never>(() => { });
                }
                return complete(entry, options);
            };
        }
        parent.postMessage({ kind: "ready",...(config.fixture&&bootstrap.secret?{credentialProof:{digest:createHash("sha256").update(bootstrap.secret).digest("hex"),argvClean:!process.argv.some(value=>value.includes(bootstrap.secret!)),envClean:!Object.values(process.env).some(value=>value?.includes(bootstrap.secret!))}}:{}), credentialsPath: service.credentialsPath, pid: process.pid, node: process.versions.node, stateDirectory: harness.config.stateDirectory });
        parent.on("message", event => {
            if (!event.data || typeof event.data !== "object" || event.data.kind !== "close-control") return;
            const { requestId, operation } = event.data as { requestId: unknown; operation: unknown };
            if (typeof requestId !== "string" || requestId.length > 128 || !["pause", "resume", "cancel"].includes(String(operation))) return;
            void (async () => {
                let busy = false;
                if (operation === "pause") busy = service.pauseAdmission();
                else if (operation === "resume") service.resumeAdmission();
                else await service.cancelActive();
                parent.postMessage({ kind: "close-control-ack", requestId, ok: true, busy });
            })().catch(() => parent.postMessage({ kind: "close-control-ack", requestId, ok: false }));
        });
        let closing = false; parent.on("message", event => { if (config.fixture && event.data && typeof event.data === "object" && "kind" in event.data && event.data.kind === "fixture-clock") { const value = event.data as { offset: number; requestId: string }; if (Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= 3600000) { fixtureClockOffset = value.offset; parent.postMessage({ kind: "fixture-clock-ack", requestId: value.requestId }); } return; } if (event.data === "close" && !closing) { closing = true; void service.close().then(() => process.exit(0), () => process.exit(1)); } });
    } catch (error) { await harness.close(); throw error; }
}
void boot().catch(error => { if (JSON.parse(process.argv[2]!).fixture) console.error(error); parent.postMessage({ kind: "failed", code: "RUNTIME_START_FAILED" }); process.exitCode = 1; });
