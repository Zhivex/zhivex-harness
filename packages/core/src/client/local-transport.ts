import { open } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { z } from "zod";
import type { HarnessClientNegotiation, HarnessClientResponse } from "./protocol.js";
import type { HarnessActivityPage } from "./service-events.js";

export const harnessLocalCredentialsSchema = z.object({ schemaVersion: z.literal(1), socketPath: z.string().min(1), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type HarnessLocalCredentials = z.infer<typeof harnessLocalCredentialsSchema>;

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
  return requestLocalServiceDocument(credentials, endpoint, payload) as Promise<E extends "hello" ? HarnessClientNegotiation : E extends "command" ? HarnessClientResponse : HarnessActivityPage>;
};

/** Internal transport used by the application layer; not a public engine export. */
export const requestLocalServiceDocument = async (
  credentials: HarnessLocalCredentials, endpoint: "hello" | "command" | "events" | "review" | "decision" | "application", payload: unknown, timeoutMs?: number
): Promise<unknown> => {
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
    // A wall-clock deadline also bounds peers that trickle bytes without completing a response.
    if (timeoutMs) {
      const deadline = setTimeout(() => {
        reject(new Error('LOCAL_SERVICE_TIMEOUT'));
        req.destroy();
      }, timeoutMs);
      req.once('close', () => clearTimeout(deadline));
    }
    req.end(encoded);
  });
};
