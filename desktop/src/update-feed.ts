import {checkUpdateManifest, requireVerifiedUpdate, type VerifiedUpdate} from "./update-manifest.js";
import {parseDesktopUpdateTrust, type DesktopUpdateTrust} from "./update-trust.js";
import {DESKTOP_STATE_FORMAT} from "./state-format.js";
export type DesktopUpdateCheckState = {status: "unconfigured" | "idle" | "checking" | "current" | "failed"} | {status: "available"; version: string; channel: "stable" | "prerelease"};
const LIMIT = 32 * 1024;
async function envelope(url: string, fetcher: typeof fetch, timeoutMs: number) {
 const controller = new AbortController();
 let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
 const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Error());}, timeoutMs);});
 try {
  for (let hop = 0; hop <= 3; hop++) {
   response = await Promise.race([fetcher(url, {signal: controller.signal, redirect: "manual", credentials: "omit", headers: {"Accept-Encoding": "identity", Accept: "application/json"}}), deadline]);
   if (![301,302,303,307,308].includes(response.status)) break;
   void response.body?.cancel().catch(() => {});
   const location = response.headers.get("location"); if (!location || hop === 3) throw new Error();
   const next = new URL(location, url);
   if (next.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(next.hostname) || next.port || next.username || next.password || next.hash) throw new Error();
   url = next.href;
  }
  if (!response || response.status !== 200 || !response.body) throw new Error();
  const encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
  if (encoding && encoding !== "identity" || length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) throw new Error();
  reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {const result = await Promise.race([reader.read(), deadline]); if (result.done) break; size += result.value.byteLength; if (size > LIMIT) throw new Error(); chunks.push(result.value);}
  if (length !== null && Number(length) !== size) throw new Error();
  return new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks));
 } finally {clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); if (!reader) void response?.body?.cancel().catch(() => {});}
}
/** Host controller: one bounded request at a time; no polling, secrets or installation. */
export function createDesktopUpdateFeed(config: DesktopUpdateTrust, currentVersion: string, options: {fetch?: typeof fetch; timeoutMs?: number} = {}) {
 const trust = parseDesktopUpdateTrust(config), timeout = options.timeoutMs ?? 15000;
 if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error("UPDATE_TIMEOUT_INVALID");
 let state: DesktopUpdateCheckState = {status: trust.enabled ? "idle" : "unconfigured"}, available: VerifiedUpdate | undefined, pending: Promise<DesktopUpdateCheckState> | undefined;
 const view = (): DesktopUpdateCheckState => {
  if (available) try {requireVerifiedUpdate(available);} catch {available = undefined; state = {status: "idle"};}
  return {...state};
 };
 return {
  state: view,
  check(): Promise<DesktopUpdateCheckState> {
   if (!trust.enabled) return Promise.resolve(view());
   if (pending) return pending;
   state = {status: "checking"}; available = undefined;
   pending = (async () => {
    try {
     const checked = checkUpdateManifest(await envelope(trust.feed, options.fetch ?? fetch, timeout), {publicKey: trust.publicKey, currentVersion, channel: trust.channel, stateSchema: DESKTOP_STATE_FORMAT});
     if (checked.kind === "available") {available = checked.update; state = {status: "available", version: available.version, channel: available.channel};} else state = {status: "current"};
    } catch {state = {status: "failed"}; available = undefined;}
    finally {pending = undefined;}
    return view();
   })();
   return pending;
  },
  verifiedUpdate() {if (!available) throw new Error("UPDATE_NOT_AVAILABLE"); requireVerifiedUpdate(available); return available;},
 };
}
