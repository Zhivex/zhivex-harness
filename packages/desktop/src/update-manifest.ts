import {createPublicKey, verify, type KeyObject} from "node:crypto";
import {z} from "zod";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function version(value: string) {
 const match = versionPattern.exec(value);
 if (!match || value.length > 128) throw new Error("UPDATE_VERSION_INVALID");
 const pre = match[4]?.split(".");
 if (pre?.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) throw new Error("UPDATE_VERSION_INVALID");
 return {core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre};
}
export function compareUpdateVersions(a: string, b: string): number {
 const left = version(a), right = version(b);
 for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! > right.core[i]! ? 1 : -1;
 if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
 for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
  const x = left.pre[i], y = right.pre[i];
  if (x === y) continue;
  if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
  const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
  if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
  if (xn !== yn) return xn ? -1 : 1;
  return x > y ? 1 : -1;
 }
 return 0;
}
const manifestSchema = z.object({
 schemaVersion: z.literal(1), product: z.literal("ai.zhivex.harness"),
 platform: z.literal("darwin"), arch: z.literal("arm64"),
 version: z.string().max(128), channel: z.enum(["stable", "prerelease"]),
 publishedAt: z.number().int().nonnegative().safe(), expiresAt: z.number().int().nonnegative().safe(),
 state: z.object({minReadable: z.number().int().min(1).max(1_000_000), maxReadable: z.number().int().min(1).max(1_000_000)}).strict(),
 artifact: z.object({url: z.string().max(2048), size: z.number().int().min(1).max(1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
}).strict();
export type UpdateManifest = z.infer<typeof manifestSchema>;
export type VerifiedUpdate = Readonly<Omit<UpdateManifest, "artifact" | "state">> & {
 readonly artifact: Readonly<UpdateManifest["artifact"]>; readonly state: Readonly<UpdateManifest["state"]>;
};
const authenticated = new WeakSet<object>();
export function requireVerifiedUpdate(update: VerifiedUpdate) {
 if (!authenticated.has(update)) throw new Error("UPDATE_NOT_AUTHENTICATED");
 if (Date.now() >= update.expiresAt) throw new Error("UPDATE_MANIFEST_EXPIRED");
}
function decode(value: string) {
 if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("UPDATE_ENVELOPE_INVALID");
 const bytes = Buffer.from(value, "base64url");
 if (bytes.toString("base64url") !== value) throw new Error("UPDATE_ENVELOPE_INVALID");
 return bytes;
}
/** The public key and policy must come from trusted host/build configuration, never the feed or renderer. */
function verifyManifest(envelope: string, policy: {
 publicKey: string | KeyObject; currentVersion: string; channel: "stable" | "prerelease"; stateSchema: number;
}, allowCurrent = false): VerifiedUpdate {
 try {
  if (Buffer.byteLength(envelope) > 32 * 1024) throw new Error();
  const parsed = z.object({payload: z.string().max(24000), signature: z.string().max(128)}).strict().parse(JSON.parse(envelope));
  const payload = decode(parsed.payload), signature = decode(parsed.signature);
  const key = typeof policy.publicKey === "string" ? createPublicKey(policy.publicKey) : policy.publicKey;
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !verify(null, payload, key, signature)) throw new Error();
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(payload)));
  const candidate = version(manifest.version), now = Date.now();
  if (manifest.channel !== policy.channel || (manifest.channel === "prerelease") !== Boolean(candidate.pre)) throw new Error();
  const order = compareUpdateVersions(manifest.version, policy.currentVersion);
  if (order < 0 || (!allowCurrent && order === 0)) throw new Error();
  if (manifest.publishedAt > now + 5 * 60_000 || manifest.expiresAt <= now || manifest.expiresAt <= manifest.publishedAt || manifest.expiresAt - manifest.publishedAt > 7 * 86400_000) throw new Error();
  if (!Number.isSafeInteger(policy.stateSchema) || manifest.state.minReadable > policy.stateSchema || manifest.state.maxReadable < policy.stateSchema || manifest.state.minReadable > manifest.state.maxReadable) throw new Error();
  const url = new URL(manifest.artifact.url);
  // Publisher cannot redirect the initial request to arbitrary hosts, repositories or API routes.
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/Zhivex\/zhivex-harness\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.dmg$/.test(url.pathname) || url.href !== manifest.artifact.url) throw new Error();
  Object.freeze(manifest.artifact); Object.freeze(manifest.state); Object.freeze(manifest);
  authenticated.add(manifest);
  return manifest;
 } catch { throw new Error("UPDATE_MANIFEST_REJECTED"); }
}

export function verifyUpdateManifest(envelope: string, policy: Parameters<typeof verifyManifest>[1]): VerifiedUpdate {
 return verifyManifest(envelope, policy);
}
/** Same-version manifests are authenticated fully, but never exposed as installable updates. */
export function checkUpdateManifest(envelope: string, policy: Parameters<typeof verifyManifest>[1]): {kind: "current"} | {kind: "available"; update: VerifiedUpdate} {
 const update = verifyManifest(envelope, policy, true);
 return compareUpdateVersions(update.version, policy.currentVersion) === 0 ? {kind: "current"} : {kind: "available", update};
}
