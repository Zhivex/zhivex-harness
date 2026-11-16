import {describe, expect, test} from "bun:test";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, stat, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {compareUpdateVersions, verifyUpdateManifest, type UpdateManifest} from "../src/update-manifest.js";
import {stageUpdateDownload} from "../src/update-download.js";

const keys = generateKeyPairSync("ed25519");
const bytes = Buffer.from("synthetic installer fixture, never an installable application");
const policy = {publicKey: keys.publicKey, currentVersion: "0.1.0-alpha.1", channel: "prerelease" as const, stateSchema: 1};
function manifest(): UpdateManifest {
 return {schemaVersion: 1, product: "ai.zhivex.harness", platform: "darwin", arch: "arm64", version: "0.1.0-alpha.2", channel: "prerelease",
  publishedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, state: {minReadable: 1, maxReadable: 1},
  artifact: {url: "https://github.com/Zhivex/zhivex-harness/releases/download/desktop-v0.1.0-alpha.2/app.dmg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}};
}
function envelope(value: unknown) {
 const payload = Buffer.from(JSON.stringify(value));
 return JSON.stringify({payload: payload.toString("base64url"), signature: sign(null, payload, keys.privateKey).toString("base64url")});
}
function verified() {return verifyUpdateManifest(envelope(manifest()), policy);}
const fakeFetch = (impl: (url: string, options?: RequestInit) => Response | Promise<Response>) => impl as unknown as typeof fetch;

describe("authenticated desktop update policy", () => {
 test("strict semantic order includes numeric prereleases and ignores build metadata", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-rc.1", "1.0.0", "1.1.0", "2.0.0"];
  for (let i = 1; i < ordered.length; i++) {
   expect(compareUpdateVersions(ordered[i]!, ordered[i - 1]!)).toBe(1);
   expect(compareUpdateVersions(ordered[i - 1]!, ordered[i]!)).toBe(-1);
  }
  expect(compareUpdateVersions("1.0.0+first", "1.0.0+second")).toBe(0);
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-01", "1.0", "1.0.0-"]) expect(() => compareUpdateVersions(invalid, "1.0.0")).toThrow();
 });
 test("verifies exact signed bytes and does not trust embedded keys or alternate algorithms", () => {
  const value = manifest(), valid = envelope(value);
  expect(verifyUpdateManifest(valid, policy).version).toBe(value.version);
  const forged = JSON.parse(valid); forged.payload = Buffer.from(JSON.stringify({...value, version: "99.0.0-alpha"})).toString("base64url");
  expect(() => verifyUpdateManifest(JSON.stringify(forged), policy)).toThrow("UPDATE_MANIFEST_REJECTED");
  expect(() => verifyUpdateManifest(valid, {...policy, publicKey: generateKeyPairSync("ed25519").publicKey})).toThrow();
  expect(() => verifyUpdateManifest(valid, {...policy, publicKey: keys.privateKey})).toThrow();
  expect(() => verifyUpdateManifest(valid, {...policy, publicKey: generateKeyPairSync("ec", {namedCurve: "prime256v1"}).publicKey})).toThrow();
  expect(() => verifyUpdateManifest(JSON.stringify({...JSON.parse(valid), publicKey: "attacker"}), policy)).toThrow();
  expect(() => verifyUpdateManifest(valid.repeat(200), policy)).toThrow();
  forged.signature = JSON.parse(valid).signature + "=";
  expect(() => verifyUpdateManifest(JSON.stringify(forged), policy)).toThrow();
 });
 test("rejects replay, wrong channel, incompatible state, expiration and foreign artifacts", () => {
  const original = manifest();
  const cases = [
   {...original, version: "0.1.0-alpha.1"}, {...original, version: "0.0.9"},
   {...original, version: "0.2.0", channel: "stable"}, {...original, version: "0.2.0"},
   {...original, state: {minReadable: 2, maxReadable: 3}}, {...original, state: {minReadable: 3, maxReadable: 1}},
   {...original, expiresAt: Date.now() - 1}, {...original, publishedAt: Date.now() + 600_000},
   {...original, expiresAt: Date.now() + 8 * 86400_000}, {...original, platform: "linux"},
   {...original, artifact: {...original.artifact, size: 2 ** 31}}, {...original, unexpected: true},
   ...["http://github.com", "https://localhost", "https://github.com.evil.test", "https://user:secret@github.com"].map(host => ({...original, artifact: {...original.artifact, url: host + "/Zhivex/zhivex-harness/releases/download/v1/a.dmg"}})),
   {...original, artifact: {...original.artifact, url: "https://github.com/attacker/repo/releases/download/v1/a.dmg"}},
  ];
  for (const value of cases) expect(() => verifyUpdateManifest(envelope(value), policy)).toThrow("UPDATE_MANIFEST_REJECTED");
  expect(verifyUpdateManifest(envelope({...original, version: "0.2.0", channel: "stable"}), {...policy, channel: "stable"}).channel).toBe("stable");
  expect(() => verifyUpdateManifest(envelope(original), {...policy, channel: "stable"})).toThrow();
 });
});

describe("bounded private update download", () => {
 async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "har-update-test-"));
  try {await run(directory);} finally {await rm(directory, {recursive: true, force: true});}
 }
 test("streams and hashes artifact, permits a bounded CDN redirect and uses private files", () => withDirectory(async directory => {
  const calls: string[] = [];
  const result = await stageUpdateDownload(verified(), {directory, fetch: fakeFetch((url, options) => {
   calls.push(url); expect(options?.redirect).toBe("manual"); expect(options?.credentials).toBe("omit");
   if (calls.length === 1) return new Response(null, {status: 302, headers: {location: "https://release-assets.githubusercontent.com/fixture?signature=synthetic"}});
   return new Response(new ReadableStream({start(controller) {controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close();}}));
  })});
  expect(calls.length).toBe(2); expect(await readFile(result.artifact)).toEqual(bytes);
  expect((await stat(result.artifact)).mode & 0o777).toBe(0o600);
  expect((await stat(result.directory)).mode & 0o777).toBe(0o700);
  expect(await readdir(result.directory)).toEqual(["update.dmg"]);
 }));
 test("rejects unverified or mutated data before making any request", () => withDirectory(async directory => {
  const update = verified(); expect(Object.isFrozen(update.artifact)).toBe(true);
  let calls = 0;
  await expect(stageUpdateDownload({...update}, {directory, fetch: fakeFetch(() => {calls++; return new Response(bytes);})})).rejects.toThrow("UPDATE_NOT_AUTHENTICATED");
  expect(calls).toBe(0); expect(await readdir(directory)).toEqual([]);
 }));
 test("cleans partial bytes on short, oversized, corrupt, rejected and interrupted downloads", () => withDirectory(async directory => {
  const factories = [
   () => new Response(bytes.subarray(0, 8)), () => new Response(Buffer.concat([bytes, bytes])),
   () => new Response(Buffer.alloc(bytes.length)), () => new Response(bytes, {status: 503}),
   () => new Response(bytes, {headers: {"content-length": "1"}}),
   () => new Response(bytes, {headers: {"content-encoding": "gzip"}}),
   () => new Response(new ReadableStream({start(c) {c.enqueue(bytes.subarray(0, 8));}, pull(c) {c.error(new Error("secret network details"));}})),
  ];
  for (const factory of factories) {
   await expect(stageUpdateDownload(verified(), {directory, fetch: fakeFetch(factory)})).rejects.toThrow("UPDATE_DOWNLOAD_FAILED");
   expect(await readdir(directory)).toEqual([]);
  }
 }));
 test("refuses unsafe redirects and redirect loops", () => withDirectory(async directory => {
  for (const location of ["https://127.0.0.1/x", "http://github.com/x", "https://release-assets.githubusercontent.com.evil.test/x", "https://user:secret@github.com/x", "https://github.com:444/x", "https://github.com/loop"]) {
   let calls = 0;
   await expect(stageUpdateDownload(verified(), {directory, fetch: fakeFetch(() => {calls++; return new Response(null, {status: 302, headers: {location}});})})).rejects.toThrow("UPDATE_DOWNLOAD_FAILED");
   expect(calls).toBeLessThanOrEqual(4); expect(await readdir(directory)).toEqual([]);
  }
 }));
 test("aborts a stalled body with a deadline and removes partial staging", () => withDirectory(async directory => {
  let cancelled = false;
  await expect(stageUpdateDownload(verified(), {directory, timeoutMs: 25, fetch: fakeFetch(() => new Response(new ReadableStream({start(c) {c.enqueue(bytes.subarray(0, 2));}, cancel() {cancelled = true;}})))})).rejects.toThrow("UPDATE_DOWNLOAD_FAILED");
  expect(cancelled).toBe(true); expect(await readdir(directory)).toEqual([]);
 }));
 test("does not follow a staging directory symlink", () => withDirectory(async directory => {
  const link = path.join(directory, "link"); await symlink(directory, link);
  await expect(stageUpdateDownload(verified(), {directory: link})).rejects.toThrow("UPDATE_DIRECTORY_UNSAFE");
  expect(await readdir(directory)).toEqual(["link"]);
 }));
 test("deadline also bounds pending fetch and caller cancellation does not expose its reason", () => withDirectory(async directory => {
  await expect(stageUpdateDownload(verified(), {directory, timeoutMs: 25, fetch: fakeFetch(() => new Promise(() => {}))})).rejects.toThrow("UPDATE_DOWNLOAD_FAILED");
  expect(await readdir(directory)).toEqual([]);
  const controller = new AbortController(); controller.abort(new Error("synthetic private reason"));
  await expect(stageUpdateDownload(verified(), {directory, signal: controller.signal})).rejects.toThrow("UPDATE_DOWNLOAD_FAILED");
  expect(await readdir(directory)).toEqual([]);
 }));
});
