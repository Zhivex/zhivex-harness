import { providerDiagnostic } from "../src/runtime/provider-diagnostics.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModel } from "@zhivex-ai/agents";
import { beginBenchmarkSpan, updateBenchmarkSpan } from "./time-to-safe-fix-progress.js";

const context = new AsyncLocalStorage<{ id: number; attempts: number }>();
// Installed only in the isolated benchmark driver. URLs/headers are never retained;
// bounded error bodies are reduced to fixed diagnostic labels.
export function observeBenchmarkFetch(): () => void {
  const original = globalThis.fetch;
  const wrapped = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const call = context.getStore();
    if (!call) return original(...args);
    const id = beginBenchmarkSpan("http", call.id, ++call.attempts);
    try {
      const response = await original(...args);
      updateBenchmarkSpan(id, { outcome: response.ok ? "completed" : "failed", httpStatus: response.status });
      if (!response.ok) updateBenchmarkSpan(id, { provider: await inspectProviderResponse(response) });
      return response;
    } catch (error) { updateBenchmarkSpan(id, { outcome: "failed", failureKind: error instanceof Error && error.name === "AbortError" ? "abort" : "transport" }); throw error; }
  }, { preconnect: original.preconnect });
  globalThis.fetch = wrapped;
  return () => { if (globalThis.fetch === wrapped) globalThis.fetch = original; };
}
export function observeBenchmarkModel(model: LanguageModel): LanguageModel {
  return new Proxy(model, { get(target, property, receiver) {
    if (property === "generate") return async (...args: Parameters<LanguageModel["generate"]>) => {
      const id = beginBenchmarkSpan("generate");
      try {
        const result = await context.run({ id, attempts: 0 }, () => target.generate(...args));
        updateBenchmarkSpan(id, { outcome: "completed" }); return result;
      } catch (error) { updateBenchmarkSpan(id, { outcome: "failed" }); throw error; }
    };
    if (property === "stream" && target.stream) return async (...args: Parameters<NonNullable<LanguageModel["stream"]>>) => {
      const id = beginBenchmarkSpan("stream");
      const started = performance.now();
      const call = { id, attempts: 0 };
      try {
        const stream = await context.run(call, () => target.stream!(...args));
        return (async function* () {
          let completed = false, failed = false, first = true;
          const iterator = stream[Symbol.asyncIterator]();
          try {
            while (true) {
              const next = await context.run(call, () => iterator.next());
              if (next.done) { completed = true; break; }
              if (first && next.value.type === "text-delta") {
                first = false; updateBenchmarkSpan(id, { firstTokenMs: Math.round(performance.now() - started) });
              }
              if (next.value.type === "error") { failed = true; updateBenchmarkSpan(id, { failureKind: "stream" }); }
              yield next.value;
            }
          } catch (error) { failed = true; updateBenchmarkSpan(id, { failureKind: "stream" }); throw error; }
          finally {
            updateBenchmarkSpan(id, { outcome: failed ? "failed" : completed ? "completed" : "cancelled" });
            if (!completed) {
              try { await context.run(call, () => iterator.return?.()); }
              catch (error) {
                updateBenchmarkSpan(id, { outcome: "failed" });
                if (!failed) throw error;
              }
            }
          }
        })();
      } catch (error) { updateBenchmarkSpan(id, { outcome: "failed" }); throw error; }
    };
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

// Error bodies are bounded in both bytes and time; original response remains untouched.
export async function inspectProviderResponse(response: Response) {
  const fallback = providerDiagnostic(undefined, response.status);
  const openReader = () => response.clone().body?.getReader();
  let reader: ReturnType<typeof openReader>;
  try { reader = openReader(); } catch { return fallback; }
  if (!reader) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 8192) return { ...fallback, bodyState: "too_large" as const };
          chunks.push(next.value);
        }
        return providerDiagnostic(Buffer.concat(chunks).toString("utf8"), response.status);
      })(),
      new Promise<typeof fallback>(resolve => { timer = setTimeout(() => resolve({ ...fallback, bodyState: "read_timeout" }), 250); })
    ]);
  } catch { return fallback; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
