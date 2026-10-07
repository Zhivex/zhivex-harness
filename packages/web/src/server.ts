import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readRegularFileNoFollow } from "@zhivex-ai/harness/desktop/v1/state";
import type { WebRuntime } from "./runtime.js";
import { createSessionCookieCipher } from "./session-cookie.js";
import { validateLimitSettings } from "./limit-settings.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const base = { workspaceKey: id };
const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("limits"), ...base }).strict(),
  z.object({ action: z.literal("configureLimits"), ...base, scope: z.enum(["task", "project"]),
    settings: z.custom<import("./limit-settings.js").LimitSettings>(validateLimitSettings), expectedRevision: z.number().int().nonnegative().safe() }).strict(),
  z.object({ action: z.literal("runLimits"), ...base, sessionId: id, runId: id }).strict(),
  z.object({action: z.literal("models"), ...base}).strict(),
  z.object({action: z.literal("selectModel"), ...base,
    provider: z.string().min(1).max(80), model: z.string().min(1).max(160),
  }).strict(),
  z.object({ action: z.literal("sessions"), ...base }).strict(),
  z
    .object({
      action: z.literal("create"),
      ...base,
      idempotencyKey: id,
      title: z.string().max(256).optional(),
    })
    .strict(),
  z.object({ action: z.literal("session"), ...base, sessionId: id }).strict(),
  z
    .object({
      action: z.literal("rename"),
      ...base,
      sessionId: id,
      expectedRevision: z.number().int().nonnegative().safe(),
      idempotencyKey: id,
      title: z.string().max(256),
    })
    .strict(),
  z
    .object({ action: z.literal("run"), ...base, sessionId: id, runId: id })
    .strict(),
  z
    .object({
      action: z.literal("start"),
      ...base,
      sessionId: id,
      expectedRevision: z.number().int().nonnegative().safe(),
      idempotencyKey: id,
      prompt: z
        .string()
        .min(1)
        .max(64 * 1024),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      ...base,
      sessionId: id,
      runId: id,
      expectedRevision: z.number().int().nonnegative().safe(),
      idempotencyKey: id,
    })
    .strict(),
  z
    .object({
      action: z.literal("events"),
      ...base,
      sessionId: id,
      after: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({ action: z.literal("review"), ...base, sessionId: id, runId: id })
    .strict(),
  z
    .object({
      action: z.literal("decide"),
      ...base,
      ticketId: z.string().uuid(),
      approve: z.boolean(),
    })
    .strict(),
]);
const secret = () => randomBytes(32).toString("hex");
const equal = (actual: unknown, expected: string) =>
  typeof actual === "string" &&
  actual.length === expected.length &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const fault = (res: ServerResponse, status: number, code: string) =>
  send(res, status, { ok: false, error: { code } });
async function body(req: IncomingMessage) {
  if (req.headers["content-type"] !== "application/json")
    throw new Error("WEB_INVALID_REQUEST");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 128 * 1024) throw new Error("WEB_INVALID_REQUEST");
    parts.push(b);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

/** Static files are an exact startup inventory, never a workspace filesystem endpoint. */
export async function staticInventory(
  directory: string,
  readAsset = readRegularFileNoFollow,
) {
  const root = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("WEB_ASSETS_UNSAFE");
  const { readdir } = await import("node:fs/promises");
  const files = new Map<string, { bytes: Buffer; type: string }>();
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) throw new Error("WEB_ASSETS_UNSAFE");
      if (info.isDirectory()) {
        await visit(filename);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
        throw new Error("WEB_ASSETS_UNSAFE");
      const canonical = await realpath(filename);
      if (!canonical.startsWith(root + path.sep))
        throw new Error("WEB_ASSETS_UNSAFE");
      try {
        // The existing public host primitive rejects symlink ancestors and FIFOs,
        // bounds positional reads, and verifies inode/size/timestamps at EOF.
        const { contents, stat: bound } = await readAsset(filename, {
          label: "WEB_ASSETS_UNSAFE",
          maxBytes: 4 * 1024 * 1024,
          requireSingleLink: true,
        });
        const retained = await lstat(filename);
        if (
          bound.ino !== info.ino ||
          bound.dev !== info.dev ||
          bound.size !== info.size ||
          bound.mtimeMs !== info.mtimeMs ||
          bound.ctimeMs !== info.ctimeMs ||
          bound.mode !== info.mode ||
          retained.ino !== bound.ino ||
          retained.dev !== bound.dev ||
          retained.size !== bound.size ||
          retained.mtimeMs !== bound.mtimeMs ||
          retained.ctimeMs !== bound.ctimeMs ||
          retained.mode !== bound.mode ||
          retained.nlink !== 1 ||
          !retained.isFile() ||
          (await realpath(filename)) !== canonical
        )
          throw new Error("WEB_ASSETS_UNSAFE");
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        files.set(
          "/" + path.relative(root, canonical).split(path.sep).join("/"),
          {
            bytes: contents,
            type: types[path.extname(filename)] ?? "application/octet-stream",
          },
        );
      } catch {
        throw new Error("WEB_ASSETS_UNSAFE");
      }
    }
  }
  await visit(root);
  if (!files.has("/index.html")) throw new Error("WEB_ASSETS_MISSING");
  return files;
}

export async function startWebServer(options: {
  runtimes: WebRuntime[];
  assetsDirectory: string;
  host?: string;
  port?: number;
  now?: () => number;
}) {
  if (options.host !== undefined && options.host !== "127.0.0.1")
    throw new Error("WEB_LOOPBACK_REQUIRED");
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  )
    throw new Error("WEB_PORT_INVALID");
  const files = await staticInventory(options.assetsDirectory);
  const runtimes = new Map(
    options.runtimes.map((runtime) => [runtime.workspace.key, runtime]),
  );
  const bootstrap = secret();
  // This public cookie label is not a credential. Its value is sealed below.
  const cookieName = `zhivex_web_${randomBytes(8).toString("hex")}`;
  const cookieCipher = createSessionCookieCipher();
  const clients = new Map<string, { csrf: string; expires: number }>();
  const now = options.now ?? Date.now;
  const bootstrapExpiry = now() + 120_000;
  let bootstrapUsed = false,
    origin = "",
    closing = false;
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cross-origin-resource-policy", "same-origin");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const operation = (async () => {
      const host = new URL(origin).host;
      if (
        req.headers.host !== host ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress ?? "",
        )
      )
        return fault(res, 403, "WEB_HOST_REJECTED");
      const site = req.headers["sec-fetch-site"];
      if (
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (site !== undefined && !["same-origin", "none"].includes(String(site)))
      )
        return fault(res, 403, "WEB_ORIGIN_REJECTED");
      if (closing) return fault(res, 503, "WEB_CLOSING");
      const route = req.url ?? "";
      if (route.startsWith("/api/")) {
        if (
          req.headers["x-zhivex-web"] !== "1" ||
          req.method !== "POST" ||
          req.headers.origin !== origin
        )
          return fault(res, 403, "WEB_ORIGIN_REJECTED");
        if (route === "/api/connect") {
          const parsed = z
            .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict()
            .safeParse(await body(req));
          if (
            !parsed.success ||
            bootstrapUsed ||
            now() >= bootstrapExpiry ||
            !equal(parsed.data.token, bootstrap)
          )
            return fault(res, 401, "WEB_PAIRING_REQUIRED");
          bootstrapUsed = true;
          const identity = secret();
          const csrf = secret();
          clients.set(identity, { csrf, expires: now() + 12 * 3600_000 });
          const cookie = cookieCipher.seal(identity, `${origin}/${cookieName}`);
          res.setHeader(
            "set-cookie",
            `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
          );
          return send(res, 200, {
            csrf,
            workspaces: options.runtimes.map((r) => r.workspace),
          });
        }
        const cookie =
          (req.headers.cookie ?? "")
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith(cookieName + "="))
            ?.slice(cookieName.length + 1) ?? "";
        const identity =
          cookieCipher.open(cookie, `${origin}/${cookieName}`) ?? "";
        const client = clients.get(identity);
        if (!client || now() >= client.expires) {
          clients.delete(identity);
          for (const r of runtimes.values()) r.forgetIdentity(identity);
          return fault(res, 401, "WEB_PAIRING_REQUIRED");
        }
        // Cookies ignore ports. The tab/origin-bound secret is required even for context/reload.
        if (!equal(req.headers["x-zhivex-csrf"], client.csrf))
          return fault(res, 403, "WEB_CSRF_REJECTED");
        if (route === "/api/context") {
          const parsed = z
            .object({})
            .strict()
            .safeParse(await body(req));
          if (!parsed.success) return fault(res, 400, "WEB_INVALID_REQUEST");
          return send(res, 200, {
            csrf: client.csrf,
            workspaces: options.runtimes.map((r) => r.workspace),
          });
        }
        if (route !== "/api/action") return fault(res, 404, "WEB_NOT_FOUND");
        const parsed = actions.safeParse(await body(req));
        if (!parsed.success) return fault(res, 400, "WEB_INVALID_REQUEST");
        const { action, workspaceKey, ...args } = parsed.data;
        const runtime = runtimes.get(workspaceKey);
        if (!runtime) return fault(res, 404, "WEB_WORKSPACE_REJECTED");
        switch (action) {
          case "limits": return send(res, 200, await runtime.limits());
          case "configureLimits": {
            const value = args as { scope: "task" | "project"; settings: import("./limit-settings.js").LimitSettings; expectedRevision: number };
            return send(res, 200, await runtime.configureLimits(value.scope, value.settings, value.expectedRevision));
          }
          case "runLimits": {
            const value = args as { sessionId: string; runId: string };
            return send(res, 200, await runtime.runLimits(value.sessionId, value.runId));
          }
          case "models":
            return send(res, 200, {choices: await runtime.modelChoices?.() ?? [],
              current: {provider: runtime.workspace.provider, model: runtime.workspace.model}});
          case "selectModel":
            if (!runtime.selectModel) return fault(res, 400, "WEB_MODEL_UNAVAILABLE");
            await runtime.selectModel(args as {provider: string; model: string});
            return send(res, 200, {workspace: runtime.workspace});
          case "events":
            return send(
              res,
              200,
              await runtime.events(
                (args as { sessionId: string }).sessionId,
                (args as { after: number }).after,
              ),
            );
          case "review":
            return send(
              res,
              200,
              await runtime.review(
                identity,
                (args as { sessionId: string }).sessionId,
                (args as { runId: string }).runId,
              ),
            );
          case "decide":
            return send(
              res,
              200,
              await runtime.decide(
                identity,
                (args as { ticketId: string }).ticketId,
                (args as { approve: boolean }).approve,
              ),
            );
          default: {
            const methods = {
              sessions: "session.list",
              create: "session.create",
              rename: "session.rename",
              session: "session.get",
              run: "run.get",
              start: "run.start",
              cancel: "run.cancel",
            };
            return send(
              res,
              200,
              await runtime.command({
                method: methods[action],
                ...args,
                ...(action === "run" ? { includeDiff: true } : {}),
              }),
            );
          }
        }
      }
      if (req.method !== "GET") return fault(res, 405, "WEB_METHOD_REJECTED");
      // Reject escapes before URL normalization. Inventory keys cannot traverse, follow symlinks or access workspaces.
      if (
        /[?#%\\]/.test(route) ||
        route.split("/").some((p) => p === ".." || p === ".")
      )
        return fault(res, 404, "WEB_NOT_FOUND");
      const file = files.get(route === "/" ? "/index.html" : route);
      if (!file) return fault(res, 404, "WEB_NOT_FOUND");
      res.writeHead(200, { "content-type": file.type });
      res.end(file.bytes);
    })().catch((error) => {
      const code =
        error instanceof Error &&
        [
          "REVIEW_REQUIRED",
          "REVIEW_EXPIRED",
          "REVIEW_INCOMPLETE",
          "INVALID_DECISION",
          "WEB_REVIEW_UNAVAILABLE",
          "WEB_MODEL_CHANGE_IN_PROGRESS", "WEB_MODEL_UNAVAILABLE", "WEB_MODEL_CHANGE_BUSY",
          "WEB_MODEL_NOT_CONFIGURED", "WEB_MODEL_SWITCH_FAILED", "WEB_CREDENTIALS_REQUIRED",
          "WEB_LIMIT_PRICING_UNAVAILABLE", "WEB_LIMIT_SETTINGS_INVALID", "WEB_LIMIT_REVISION_CONFLICT", "WEB_LIMIT_RUN_INVALID", "WEB_LIMIT_STORAGE_UNSAFE",
        ].includes(error.message)
          ? error.message
          : "WEB_REQUEST_FAILED";
      if (!res.headersSent) fault(res, 400, code);
      else res.destroy();
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  // No WebSocket transport; upgrade requests never reach Harness.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error) => {
    cookieCipher.destroy();
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("WEB_LISTEN_FAILED");
  origin = `http://127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;
  return {
    origin,
    launchUrl: `${origin}/#connect=${bootstrap}`,
    close() {
      return (closePromise ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
        // Cancel through the existing runtime owner, then drain admitted commands.
        const results = await Promise.allSettled(
          options.runtimes.map((r) => r.close()),
        );
        await Promise.allSettled([...pending]);
        server.closeAllConnections();
        await stopped;
        cookieCipher.destroy();
        clients.clear();
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })());
    },
  };
}
