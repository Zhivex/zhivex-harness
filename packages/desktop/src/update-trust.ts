import {createPublicKey} from "node:crypto";
import {z} from "zod";
const feed = z.string().max(2048).refine(value => {
 try {const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.href === value && /^\/Zhivex\/zhivex-harness\/releases\/(?:latest\/download|download\/[A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+\.json$/.test(url.pathname);} catch {return false;}
});
const schema = z.discriminatedUnion("enabled", [
 z.object({schemaVersion: z.literal(1), enabled: z.literal(false)}).strict(),
 z.object({schemaVersion: z.literal(1), enabled: z.literal(true), feed, publicKey: z.string().max(4096), teamId: z.string().regex(/^[A-Z0-9]{10}$/), channel: z.enum(["stable", "prerelease"])}).strict(),
]);
/** Build-owned input only. Never accept trust configuration from IPC or a feed. */
export function parseDesktopUpdateTrust(input: unknown) {
 try {
  const value = schema.parse(input);
  if (value.enabled) {const key = createPublicKey(value.publicKey); if (key.type !== "public" || key.asymmetricKeyType !== "ed25519" || !value.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error();}
  return Object.freeze(value);
 } catch {throw new Error("UPDATE_TRUST_INVALID");}
}
export type DesktopUpdateTrust = ReturnType<typeof parseDesktopUpdateTrust>;
