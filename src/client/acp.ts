import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { HarnessClientAdapter, HarnessClientCommand, HarnessClientData } from "./protocol.js";

const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number().int()]).optional(), method: z.string(), params: z.unknown().optional() }).strict();
const sessionParams = z.object({ sessionId: z.string().min(1) }).strict();
const permissionResult = z.object({ outcome: z.union([
  z.object({ outcome: z.literal("cancelled") }).strict(),
  z.object({ outcome: z.literal("selected"), optionId: z.enum(["allow_once", "reject_once"]) }).strict()
]) });
export interface AcpConnectionOptions {
  /** Fixed host-owned workspace. Client requests cannot change it. */
  workspace: string;
  notify(message: { jsonrpc: "2.0"; method: "session/update"; params: Record<string, unknown> }): void | Promise<void>;
  requestPermission(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
type ProjectlessCommand = HarnessClientCommand extends infer C ? C extends { projectId: string } ? Omit<C, "projectId"> : never : never;
class AcpFault extends Error { constructor(readonly code: number, message: string) { super(message); } }

/** Embedding adapter for ACP v1 text sessions, not a complete ACP implementation.
 * No transport, session loading, client filesystem/terminal, or client-supplied MCP.
 * Every approval remains bound to the existing adapter's revision/digest checks. */
export const createAcpConnection = (adapter: HarnessClientAdapter, options: AcpConnectionOptions) => {
  if (!isAbsolute(options.workspace)) throw new Error("ACP workspace must be absolute");
  const negotiated = adapter.negotiate([1]);
  if (!negotiated.ok) throw new Error(negotiated.error.code);
  let initialized = false;
  const sessions = new Set<string>();
  let active: { sessionId: string; cancelled: boolean; cancel: () => void; cancellation: Promise<void> } | undefined;
  const command = async (value: ProjectlessCommand): Promise<HarnessClientData> => {
    const response = await adapter.dispatch({ protocolVersion: 1, requestId: randomUUID(), connectionId: negotiated.connectionId,
      command: { ...value, projectId: negotiated.projectId } });
    if (!response.ok) throw new AcpFault(-32000, response.error.code);
    return response.data;
  };
  const requireSession = (id: string) => { if (!sessions.has(id)) throw new AcpFault(-32602, "Unknown session"); };
  const execute = async (method: string, params: unknown): Promise<unknown> => {
    if (method === "initialize") {
      const input = z.object({ protocolVersion: z.literal(1), clientCapabilities: z.record(z.string(), z.unknown()).optional(), clientInfo: z.unknown().optional(), _meta: z.unknown().optional() }).parse(params);
      void input;
      initialized = true;
      return { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
        authMethods: [], agentInfo: { name: "zhivex-harness", title: "Zhivex Harness (text-session subset)", version: "1" },
        _meta: { zhivex: { subset: true, fixedWorkspace: true, clientMcp: false } } };
    }
    if (!initialized) throw new AcpFault(-32002, "Initialize first");
    if (method === "session/new") {
      if (sessions.size >= 256) throw new AcpFault(-32000, "Session capacity exceeded");
      if (active) throw new AcpFault(-32000, "BUSY");
      const input = z.object({ cwd: z.string(), mcpServers: z.array(z.unknown()).max(0) }).strict().parse(params);
      if (!isAbsolute(input.cwd) || resolve(input.cwd) !== resolve(options.workspace)) throw new AcpFault(-32602, "Workspace is host-owned");
      const data = await command({ method: "session.create", idempotencyKey: randomUUID() });
      if (data.kind !== "session") throw new AcpFault(-32603, "Invalid adapter response");
      sessions.add(data.session.sessionId);
      return { sessionId: data.session.sessionId };
    }
    if (method === "session/cancel") {
      const input = sessionParams.parse(params); requireSession(input.sessionId);
      if (active?.sessionId === input.sessionId) { active.cancelled = true; active.cancel(); await adapter.cancelActive(); }
      return {};
    }
    if (method !== "session/prompt") throw new AcpFault(-32601, "Method not supported");
    const input = sessionParams.extend({ prompt: z.array(z.object({ type: z.literal("text"), text: z.string().max(64 * 1024) }).strict()).min(1).max(64) }).parse(params);
    requireSession(input.sessionId);
    const prompt = input.prompt.map(block => block.text).join("\n");
    if (!prompt.trim() || prompt.length > 64 * 1024) throw new AcpFault(-32602, "Invalid prompt size");
    if (active) throw new AcpFault(-32000, "BUSY");
    const permissionController = new AbortController();
    let cancel!: () => void;
    const current = { sessionId: input.sessionId, cancelled: false, cancellation: new Promise<void>(resolve => { cancel = resolve; }), cancel: () => { permissionController.abort(); cancel(); } };
    active = current;
    try {
      const session = await command({ method: "session.get", sessionId: input.sessionId });
      if (session.kind !== "session") throw new AcpFault(-32603, "Invalid adapter response");
      if (current.cancelled) return { stopReason: "cancelled" };
      let data = await command({ method: "run.start", sessionId: input.sessionId, expectedRevision: session.session.revision,
        prompt, idempotencyKey: randomUUID() });
      while (data.kind === "run" && data.run.status === "waiting_approval" && !current.cancelled) {
        const decisions = [];
        for (const approval of data.run.approvals) {
          const answer = await Promise.race([options.requestPermission({ sessionId: input.sessionId,
            toolCall: { toolCallId: approval.approvalId, title: "Review pending action", kind: "other", status: "pending", rawInput: approval.action },
            options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }, { optionId: "reject_once", name: "Reject once", kind: "reject_once" }] }, permissionController.signal),
            current.cancellation.then(() => ({ outcome: { outcome: "cancelled" } }))]);
          const result = permissionResult.parse(answer);
          if (result.outcome.outcome === "cancelled" || current.cancelled) { current.cancelled = true; break; }
          decisions.push({ approvalId: approval.approvalId, digest: approval.digest, approve: result.outcome.optionId === "allow_once" });
        }
        if (current.cancelled) break;
        if (!decisions.length) throw new AcpFault(-32603, "Missing pending approval");
        data = await command({ method: "approval.resolve", sessionId: input.sessionId, runId: data.run.runId,
          expectedRevision: data.run.revision, decisions, idempotencyKey: randomUUID() });
      }
      if (data.kind !== "run") throw new AcpFault(-32603, "Invalid adapter response");
      if (current.cancelled && !["completed", "failed", "cancelled", "timed_out"].includes(data.run.status)) {
        await command({ method: "run.cancel", sessionId: input.sessionId, runId: data.run.runId,
          expectedRevision: data.run.revision, idempotencyKey: randomUUID() });
      }
      if (data.run.output) await options.notify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: input.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.run.output } } } });
      return { stopReason: current.cancelled || data.run.status === "cancelled" ? "cancelled" : data.run.status === "completed" ? "end_turn" : "refusal" };
    } catch (error) {
      if (current.cancelled) return { stopReason: "cancelled" };
      throw error;
    } finally { permissionController.abort(); active = undefined; }
  };
  return {
    async cancelActive() {
      if (active) { active.cancelled = true; active.cancel(); }
      await adapter.cancelActive();
    },
    async handle(value: unknown): Promise<unknown> {
      const parsed = envelope.safeParse(value);
      if (!parsed.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
      const request = parsed.data;
      // Only cancellation is a valid notification; never execute unacknowledged mutations.
      if (request.id === undefined && request.method !== "session/cancel") return undefined;
      try {
        const result = await execute(request.method, request.params);
        return request.id === undefined ? undefined : { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        if (request.id === undefined) return undefined;
        return { jsonrpc: "2.0", id: request.id, error: { code: error instanceof AcpFault ? error.code : error instanceof z.ZodError ? -32602 : -32603,
          message: error instanceof AcpFault ? error.message : error instanceof z.ZodError ? "Invalid params" : "Internal error" } };
      }
    }
  };
};
