import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { createAcpConnection } from "./acp.js";
import type { HarnessClientAdapter } from "./protocol.js";

/** JSON-lines transport. Bounded frames and pending requests; stdout contains JSON-RPC only. */
export const serveAcpStdio = async (adapter: HarnessClientAdapter, options: {
  workspace: string; input: Readable; output: Writable; permissionTimeoutMs?: number;
}) => {
  const timeoutMs = options.permissionTimeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new Error("Invalid ACP permission timeout");
  const pending = new Map<string, { resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const jobs = new Set<Promise<void>>();
  const inflight = new Set<string>();
  const write = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
    options.output.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve());
  });
  let transportFailure: unknown;
  const connection = createAcpConnection(adapter, {
    workspace: options.workspace,
    notify: write,
    requestPermission: async (params, signal) => {
      const id = `permission_${randomUUID()}`;
      const cancel = () => { const request = pending.get(id); if (request) { clearTimeout(request.timer); pending.delete(id); request.resolve({ outcome: { outcome: "cancelled" } }); } };
      const response = new Promise<unknown>(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ outcome: { outcome: "cancelled" } }); }, timeoutMs);
        timer.unref(); pending.set(id, { resolve, timer });
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      try { if (!signal?.aborted) await write({ jsonrpc: "2.0", id, method: "session/request_permission", params }); return await response; }
      finally { signal?.removeEventListener("abort", cancel); const request = pending.get(id); if (request) clearTimeout(request.timer); pending.delete(id); }
    }
  });
  const dispatch = async (line: string) => {
    let value: any;
    try { value = JSON.parse(line); } catch { await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (value?.jsonrpc === "2.0" && typeof value.id === "string" && value.method === undefined) {
      const request = pending.get(value.id);
      if (request) {
        clearTimeout(request.timer); pending.delete(value.id);
        request.resolve("result" in value && !("error" in value) ? value.result : { outcome: { outcome: "cancelled" } });
      }
      return;
    }
    const key = value?.id === undefined ? undefined : JSON.stringify(value.id);
    if (key && inflight.has(key)) { await write({ jsonrpc: "2.0", id: value.id, error: { code: -32600, message: "Request ID already active" } }); return; }
    if (key) inflight.add(key);
    try { const response = await connection.handle(value); if (response !== undefined) await write(response); }
    finally { if (key) inflight.delete(key); }
  };
  const launch = (line: string) => {
    if (!line.trim()) return;
    // Bound simultaneous protocol handlers, including malformed client floods.
    if (jobs.size >= 64) throw new Error("ACP request capacity exceeded");
    const job = dispatch(line).catch(error => { transportFailure = error; options.input.destroy(); });
    jobs.add(job); void job.finally(() => jobs.delete(job));
  };
  let buffer = Buffer.alloc(0);
  try {
    for await (const chunk of options.input) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline > 1024 * 1024) throw new Error("ACP frame exceeds 1 MiB");
        const line = buffer.subarray(0, newline).toString("utf8"); buffer = buffer.subarray(newline + 1); launch(line);
      }
      if (buffer.length > 1024 * 1024) throw new Error("ACP frame exceeds 1 MiB");
    }
    if (buffer.length) launch(buffer.toString("utf8"));
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ outcome: { outcome: "cancelled" } }); }
    pending.clear();
    await connection.cancelActive();
    await Promise.allSettled(jobs);
  }
  if (transportFailure) throw transportFailure;
};
