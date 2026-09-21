import {expect, test} from "bun:test";
import {createHash, generateKeyPairSync, sign} from "node:crypto";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createDesktopUpdateFeed} from "../src/update-feed.js";
import {createDesktopUpdateSession} from "../src/update-session.js";
import {parseDesktopUpdateTrust} from "../src/update-trust.js";
import {registerDesktopUpdateIpc} from "../src/update-ipc.js";
const keys = generateKeyPairSync("ed25519"), bytes = Buffer.from("fixture disk image");
const trust = parseDesktopUpdateTrust({schemaVersion: 1, enabled: true, feed: "https://github.com/Zhivex/zhivex-harness/releases/latest/download/desktop.json", publicKey: keys.publicKey.export({format: "pem", type: "spki"}).toString(), teamId: "ABCDEFGHIJ", channel: "stable"});
function manifest() {
 const payload = Buffer.from(JSON.stringify({schemaVersion: 1, product: "ai.zhivex.harness", platform: "darwin", arch: "arm64", version: "1.1.0", channel: "stable", publishedAt: Date.now() - 1000, expiresAt: Date.now() + 60000, state: {minReadable: 1, maxReadable: 1}, artifact: {url: "https://github.com/Zhivex/zhivex-harness/releases/download/v1.1.0/app.dmg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")}}));
 return JSON.stringify({payload: payload.toString("base64url"), signature: sign(null, payload, keys.privateKey).toString("base64url")});
}
const fetcher = (fn: () => Promise<Response> | Response) => fn as unknown as typeof fetch;
test("IPC downloads authenticated bytes once, keeps paths private, and releases the staged version on recheck", async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), "update-session-"));
 try {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const feed = createDesktopUpdateFeed(trust, "1.0.0", {fetch: fetcher(() => new Response(manifest()))});
  const session = createDesktopUpdateSession(feed, {directory, fetch: fetcher(async () => {calls++; await gate; return new Response(bytes);})});
  const handlers = new Map<string, (...args: any[]) => any>();
  registerDesktopUpdateIpc({handle: (name, handler) => {handlers.set(name, handler);}}, event => {if (!(event as unknown as {trusted: boolean}).trusted) throw new Error("UNTRUSTED_SENDER");}, session);
  const download = handlers.get("harness:download-update")!;
  expect(() => download({trusted: false})).toThrow("UNTRUSTED_SENDER");
  expect(() => download({trusted: true}, {directory: "/tmp/other"})).toThrow("INVALID_UPDATE_REQUEST");
  expect(await download({trusted: true})).toEqual({status: "idle"});
  await session.check();
  const first = download({trusted: true});
  expect(download({trusted: true})).toBe(first);
  expect(session.check()).toBe(first);
  expect(session.state().status).toBe("downloading");
  expect(() => session.preparedDownload()).toThrow("UPDATE_NOT_DOWNLOADED");
  release();
  expect(await first).toEqual({status: "downloaded", version: "1.1.0", channel: "stable"});
  expect(calls).toBe(1);
  const prepared = session.preparedDownload();
  expect(await readFile(prepared.download.artifact)).toEqual(bytes);
  prepared.download.artifact = "/untrusted";
  expect(session.preparedDownload().download.artifact).not.toBe("/untrusted");
  await session.check();
  expect(await readdir(directory)).toEqual([]);
  expect(() => session.preparedDownload()).toThrow("UPDATE_NOT_DOWNLOADED");
 } finally {await rm(directory, {recursive: true, force: true});}
});
test("bad artifact bytes are removed, failure is sanitized, and retry uses the authenticated manifest", async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), "update-session-"));
 try {
  let calls = 0;
  const feed = createDesktopUpdateFeed(trust, "1.0.0", {fetch: fetcher(() => new Response(manifest()))});
  const session = createDesktopUpdateSession(feed, {directory, fetch: fetcher(() => new Response(calls++ ? bytes : Buffer.alloc(bytes.length)))});
  await session.check();
  expect((await session.download()).status).toBe("download-failed");
  expect(await readdir(directory)).toEqual([]);
  expect(() => session.preparedDownload()).toThrow("UPDATE_NOT_DOWNLOADED");
  expect((await session.download()).status).toBe("downloaded");
 } finally {await rm(directory, {recursive: true, force: true});}
});
