import {expect, test} from "bun:test";
import {generateKeyPairSync, sign} from "node:crypto";
import {createDesktopUpdateFeed} from "../src/update-feed.js";
import {parseDesktopUpdateTrust} from "../src/update-trust.js";
import {createDesktopUpdateSession} from "../src/update-session.js";
import {registerDesktopUpdateIpc} from "../src/update-ipc.js";
import {requireVerifiedUpdate} from "../src/update-manifest.js";
const keys = generateKeyPairSync("ed25519");
const trust = parseDesktopUpdateTrust({schemaVersion: 1, enabled: true, feed: "https://github.com/Zhivex/zhivex-harness/releases/latest/download/desktop.json", publicKey: keys.publicKey.export({format: "pem", type: "spki"}).toString(), teamId: "ABCDEFGHIJ", channel: "stable"});
function signed(version = "1.1.0") {
 const payload = Buffer.from(JSON.stringify({schemaVersion: 1, product: "ai.zhivex.harness", platform: "darwin", arch: "arm64", version, channel: "stable", publishedAt: Date.now() - 1000, expiresAt: Date.now() + 60000, state: {minReadable: 1, maxReadable: 1}, artifact: {url: "https://github.com/Zhivex/zhivex-harness/releases/download/v1.1.0/app.dmg", size: 1, sha256: "a".repeat(64)}}));
 return JSON.stringify({payload: payload.toString("base64url"), signature: sign(null, payload, keys.privateKey).toString("base64url")});
}
const fetcher = (f: (url: string, init?: RequestInit) => Response | Promise<Response>) => f as unknown as typeof fetch;
test("disabled trust makes no request; strict configuration rejects remote/private keys and alternate feeds", async () => {
 const feed = createDesktopUpdateFeed(parseDesktopUpdateTrust({schemaVersion: 1, enabled: false}), "1.0.0", {fetch: fetcher(() => {throw new Error("must not call");})});
 expect(await feed.check()).toEqual({status: "unconfigured"});
 expect(() => parseDesktopUpdateTrust({...trust, feed: "http://localhost/feed"})).toThrow("UPDATE_TRUST_INVALID");
 expect(() => parseDesktopUpdateTrust({...trust, publicKey: keys.privateKey.export({type: "pkcs8", format: "pem"}).toString()})).toThrow("UPDATE_TRUST_INVALID");
 expect(() => parseDesktopUpdateTrust({...trust, keyUrl: "https://example.com/key"})).toThrow("UPDATE_TRUST_INVALID");
});
test("host retains authenticated update while renderer gets only version and channel; concurrent checks share one request", async () => {
 let calls = 0, release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
 const feed = createDesktopUpdateFeed(trust, "1.0.0", {fetch: fetcher(async (_url, init) => {calls++; expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual"); await gate; return new Response(signed());})});
 const first = feed.check(); expect(feed.check()).toBe(first); expect(feed.state()).toEqual({status: "checking"}); release();
 expect(await first).toEqual({status: "available", version: "1.1.0", channel: "stable"}); expect(calls).toBe(1);
 expect(() => requireVerifiedUpdate(feed.verifiedUpdate())).not.toThrow();
});
test("current-version response still requires a valid signature and cannot authorize download", async () => {
 const feed = createDesktopUpdateFeed(trust, "1.0.0", {fetch: fetcher(() => new Response(signed("1.0.0")))});
 expect(await feed.check()).toEqual({status: "current"}); expect(() => feed.verifiedUpdate()).toThrow("UPDATE_NOT_AVAILABLE");
 const rejected = createDesktopUpdateFeed(trust, "1.0.0", {fetch: fetcher(() => new Response(JSON.stringify({...JSON.parse(signed("1.0.0")), signature: "a".repeat(86)})))});
 expect(await rejected.check()).toEqual({status: "failed"});
});
test("unsafe redirects, oversized bodies, stalled requests and detailed errors yield only sanitized failure", async () => {
 for (const impl of [
  () => new Response(null, {status: 302, headers: {location: "http://127.0.0.1/private"}}),
  () => new Response("x".repeat(32769)),
  () => new Response("x", {headers: {"content-length": "50000"}}),
  () => Promise.reject(new Error("private diagnostic")),
  () => new Promise<Response>(() => {}),
 ]) {
  const feed = createDesktopUpdateFeed(trust, "1.0.0", {fetch: fetcher(impl), timeoutMs: 20});
  expect(await feed.check()).toEqual({status: "failed"}); expect(() => feed.verifiedUpdate()).toThrow("UPDATE_NOT_AVAILABLE");
 }
});
test("IPC validates sender and refuses all renderer configuration arguments", async () => {
 const handlers = new Map<string, (...args: any[]) => any>(), feed = createDesktopUpdateFeed(parseDesktopUpdateTrust({schemaVersion: 1, enabled: false}), "1.0.0");
 registerDesktopUpdateIpc({handle: (name, handler) => {handlers.set(name, handler);}}, event => {if (!(event as unknown as {trusted: boolean}).trusted) throw new Error("UNTRUSTED_SENDER");}, createDesktopUpdateSession(feed, {directory: "/unused"}));
 expect(() => handlers.get("harness:check-updates")!({trusted: false})).toThrow("UNTRUSTED_SENDER");
 expect(() => handlers.get("harness:check-updates")!({trusted: true}, {feed: "alternate"})).toThrow("INVALID_UPDATE_REQUEST");
 expect(await handlers.get("harness:check-updates")!({trusted: true})).toEqual({status: "unconfigured"});
});
