/** User-private Unix transport for the shared Harness client contract. */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, lstat, realpath, open, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createHarnessClientAdapter, type HarnessClientAdapter, type HarnessClientResponse, type HarnessClientNegotiation } from "./client-contract.js";
import { openHarnessActivityStore, type HarnessActivityStore, type HarnessActivityPage } from "./service-events.js";
import type { ZhivexHarness } from "./harness.js";

export interface HarnessLocalService {
  readonly socketPath: string;
  readonly credentialsPath: string;
  /** Stops admission, drains accepted commands, closes adapter and host runtime. */
  close(): Promise<void>;
}
export interface HarnessLocalServiceOptions { directory: string; approvalNow?: () => number; sensitiveValues?: readonly string[]; maxEvents?: number; retentionMs?: number }
export const harnessLocalCredentialsSchema = z.object({ schemaVersion: z.literal(1), socketPath: z.string().min(1), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type HarnessLocalCredentials = z.infer<typeof harnessLocalCredentialsSchema>;

const send = (response: ServerResponse, status: number, document: unknown) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "connection": "close" });
  response.end(JSON.stringify(document));
};
const fault = (code: string) => ({ ok: false, error: { code } });
const body = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 128 * 1024) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const privateFile = async (filename: string, data: string) => {
  const file = await open(filename, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
};
const exists = async (filename: string) => {
  try { return await lstat(filename); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
};

export const startHarnessLocalService = async (harness: ZhivexHarness, options: HarnessLocalServiceOptions): Promise<HarnessLocalService> => {
  if (process.platform === "win32") throw new Error("LOCAL_SERVICE_PLATFORM_UNSUPPORTED");
  const directory = path.resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("LOCAL_SERVICE_DIRECTORY_UNSAFE");
  const canonicalDirectory = await realpath(directory);
  const workspaceIdentity = createHash("sha256").update(JSON.stringify([harness.config.workspace, harness.config.scope])).digest("hex").slice(0, 20);
  const socketPath = path.join(canonicalDirectory, `${workspaceIdentity}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("LOCAL_SERVICE_SOCKET_PATH_TOO_LONG");
  const credentialsPath = path.join(canonicalDirectory, `${workspaceIdentity}.json`);
  const lockPath = path.join(canonicalDirectory, `${workspaceIdentity}.lock`);
  const token = randomBytes(32).toString("hex");
  // Never steal a lock or unlink a pre-existing socket, even after suspected crash.
  // Recovery must prove the old process is gone and preserve its runtime state.
  await privateFile(lockPath, JSON.stringify({ schemaVersion: 1, pid: process.pid }));
  let adapter: HarnessClientAdapter | undefined;
  let activity: HarnessActivityStore | undefined;
  const pending = new Set<Promise<void>>();
  let closing = false, closePromise: Promise<void> | undefined;
  const server = createServer((req, res) => {
    const operation = (async () => {
      const actual = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, fault("UNAUTHORIZED"));
      // No browser-origin requests are accepted, including same-host/file origins.
      if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) return send(res, 403, fault("ORIGIN_REJECTED"));
      if (closing) return send(res, 503, fault("SERVICE_CLOSING"));
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, schemaVersion: 1, status: "ready" });
      if (req.method !== "POST" || !["/hello", "/command", "/events"].includes(req.url ?? "")) return send(res, 404, fault("NOT_FOUND"));
      if (req.headers["content-type"] !== "application/json") return send(res, 415, fault("CONTENT_TYPE_REQUIRED"));
      let value: unknown;
      try { value = await body(req); } catch { return send(res, 400, fault("INVALID_REQUEST")); }
      if (req.url === "/hello") {
        const parsed = z.object({ versions: z.array(z.number().int()).min(1).max(16) }).strict().safeParse(value);
        return send(res, 200, parsed.success ? adapter!.negotiate(parsed.data.versions) : fault("INVALID_REQUEST"));
      }
      if (req.url === "/events") {
        const parsed = z.object({projectId:z.string(),sessionId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),after:z.number().int().nonnegative().safe().optional()}).strict().safeParse(value);
        const hello=adapter!.negotiate([1]);
        if(!parsed.success)return send(res,400,fault("INVALID_REQUEST"));
        if(!hello.ok||parsed.data.projectId!==hello.projectId)return send(res,404,fault("NOT_FOUND"));
        try{return send(res,200,activity!.replay(parsed.data.sessionId,parsed.data.after));}
        catch{return send(res,400,fault("INVALID_CURSOR"));}
      }
      return send(res, 200, await adapter!.dispatch(value));
    })().catch(() => { if (!res.headersSent) send(res, 500, fault("EXECUTION_FAILED")); else res.destroy(); });
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  });
  server.requestTimeout = Math.max(30_000, harness.config.timeoutMs + 10_000);
  server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000;
  let ownsSocket = false, ownsCredentials = false;
  const cleanup = async () => {
    if (ownsSocket) await unlink(socketPath).catch(e => { if (e.code !== "ENOENT") throw e; });
    if (ownsCredentials) await unlink(credentialsPath).catch(e => { if (e.code !== "ENOENT") throw e; });
    await unlink(lockPath);
  };
  try {
    if (await exists(socketPath) || await exists(credentialsPath)) throw new Error("LOCAL_SERVICE_STALE_STATE");
    activity = await openHarnessActivityStore(harness.config, {
      sensitiveValues: [token, ...(options.sensitiveValues ?? []), ...Object.entries(process.env).filter(([k,v])=>/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(k) && v && v.length>=8).map(([,v])=>v!)],
      ...(options.maxEvents===undefined?{}:{maxEvents:options.maxEvents}), ...(options.retentionMs===undefined?{}:{retentionMs:options.retentionMs})
    });
    adapter = await createHarnessClientAdapter(harness, {
      ...(options.approvalNow?{now:options.approvalNow}:{}),
      onPrompt: (sessionId,runId,prompt) => activity!.prompt(sessionId,runId,prompt),
      onEvent: (sessionId,runId,event) => activity!.append(sessionId,runId,event),
      onCheckpoint: (sessionId,runId,status) => activity!.checkpoint(sessionId,runId,status)
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
    ownsSocket = true;
    await chmod(socketPath, 0o600);
    await privateFile(credentialsPath, JSON.stringify({ schemaVersion: 1, socketPath, token })); ownsCredentials = true;
    return { socketPath, credentialsPath, close() {
      closePromise ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
        await Promise.allSettled([...pending]); await stopped;
        adapter!.close(); activity!.close(); await harness.close(); await cleanup();
      })();
      return closePromise;
    } };
  } catch (e) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    adapter?.close(); activity?.close(); await cleanup(); throw e;
  }
};

/** Read only an owner-private regular credential file; never follow a symlink. */
export const readHarnessLocalCredentials = async (filename: string): Promise<HarnessLocalCredentials> => {
  const { constants } = await import("node:fs");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 4096) throw new Error("LOCAL_SERVICE_CREDENTIALS_UNSAFE");
    return harnessLocalCredentialsSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
};

export const requestHarnessLocalService = async <E extends "hello" | "command" | "events">(
  credentials: HarnessLocalCredentials, endpoint: E, payload: unknown
): Promise<E extends "hello" ? HarnessClientNegotiation : E extends "command" ? HarnessClientResponse : HarnessActivityPage> => {
  const parsed = harnessLocalCredentialsSchema.parse(credentials);
  if (!path.isAbsolute(parsed.socketPath) || process.platform === "win32") throw new Error("LOCAL_SERVICE_SOCKET_INVALID");
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 128 * 1024) throw new Error("REQUEST_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: parsed.socketPath, path: `/${endpoint}`, method: "POST", headers: {
      authorization: `Bearer ${parsed.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(encoded)
    } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) res.destroy(new Error("RESPONSE_TOO_LARGE")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => { try {
        if (res.statusCode !== 200) return reject(new Error(`LOCAL_SERVICE_HTTP_${res.statusCode}`));
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch { reject(new Error("LOCAL_SERVICE_RESPONSE_INVALID")); } });
    });
    req.on("error", () => reject(new Error("LOCAL_SERVICE_UNAVAILABLE")));
    req.end(encoded);
  });
};

/** Explicit dead-owner recovery: preserves runtime DBs and never steals a live lease. */
export const recoverHarnessLocalService = async (harness: ZhivexHarness, directory: string): Promise<void> => {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("LOCAL_SERVICE_DIRECTORY_UNSAFE");
  const root = await realpath(directory);
  const identity = createHash("sha256").update(JSON.stringify([harness.config.workspace, harness.config.scope])).digest("hex").slice(0, 20);
  const lockPath = path.join(root, `${identity}.lock`);
  const { constants } = await import("node:fs");
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let owner: { schemaVersion: 1; pid: number };
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error("LOCAL_SERVICE_LOCK_UNSAFE");
    owner = z.object({schemaVersion:z.literal(1),pid:z.number().int().positive().max(2**31-1)}).strict().parse(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
  try { process.kill(owner.pid, 0); throw new Error("LOCAL_SERVICE_OWNER_ALIVE"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  for (const extension of ["sock", "json"]) {
    const filename = path.join(root, `${identity}.${extension}`);const entry = await exists(filename);
    if (!entry) continue;
    if (entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0 || (extension === "sock" ? !entry.isSocket() : !entry.isFile())) throw new Error("LOCAL_SERVICE_RECOVERY_UNSAFE");
  }
  for (const extension of ["sock", "json"]) await unlink(path.join(root, `${identity}.${extension}`)).catch(e=>{if(e.code!=="ENOENT")throw e;});
  await unlink(lockPath);
};
