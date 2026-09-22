import {rm} from "node:fs/promises";
import type {createDesktopUpdateFeed, DesktopUpdateCheckState} from "./update-feed.js";
import {stageUpdateDownload} from "./update-download.js";
import {requireVerifiedUpdate, type VerifiedUpdate} from "./update-manifest.js";
import {DesktopInstallError, type PreparedDesktopDownload} from "./update-install.js";

export type DesktopUpdateState = DesktopUpdateCheckState | {status: "downloading" | "downloaded" | "download-failed" | "installing" | "restarting" | "work-active" | "install-failed" | "recovery-required"; version: string; channel: "stable" | "prerelease"};
/** Paths and authenticated manifests stay in main; the renderer supplies no inputs. */
export function createDesktopUpdateSession(feed: ReturnType<typeof createDesktopUpdateFeed>, options: {directory: string; fetch?: typeof fetch; install?: (prepared: PreparedDesktopDownload) => Promise<void>}) {
 let transfer: DesktopUpdateState | undefined;
 let staged: {update: VerifiedUpdate; download: Awaited<ReturnType<typeof stageUpdateDownload>>} | undefined;
 let pending: Promise<DesktopUpdateState> | undefined;
 const view = (): DesktopUpdateState => ({...(transfer ?? feed.state())});
 return {
  state: view,
  check(): Promise<DesktopUpdateState> {
   if (transfer?.status === "recovery-required" || transfer?.status === "restarting") return Promise.resolve(view());
   if (pending) return pending;
   pending = (async () => {
    // Cleanup must complete before another version can be selected.
    if (staged) {await rm(staged.download.directory, {recursive: true, force: true}); staged = undefined;}
    transfer = undefined;
    return feed.check();
   })().catch(() => {transfer = {status: "failed"}; return view();}).finally(() => {pending = undefined;});
   return pending;
  },
  install(): Promise<DesktopUpdateState> {
   if (pending) return pending;
   if (!staged || transfer?.status === "recovery-required" || transfer?.status === "restarting") return Promise.resolve(view());
   const prepared = {update: staged.update, download: {...staged.download}};
   const identity = {version: prepared.update.version, channel: prepared.update.channel};
   transfer = {status: "installing", ...identity};
   pending = (async () => {
    try {
     requireVerifiedUpdate(prepared.update);
     if (!options.install) throw new Error();
     await options.install(prepared); transfer = {status: "restarting", ...identity};
    } catch (error) {transfer = {status: error instanceof DesktopInstallError ? error.status : "install-failed", ...identity};}
    return view();
   })().finally(() => {pending = undefined;});
   return pending;
  },
  download(): Promise<DesktopUpdateState> {
   if (pending) return pending;
   if (staged) return Promise.resolve(view());
   let update: VerifiedUpdate;
   try {update = feed.verifiedUpdate();} catch {return Promise.resolve(feed.state());}
   const identity = {version: update.version, channel: update.channel};
   transfer = {status: "downloading", ...identity};
   pending = (async () => {
    try {const download = await stageUpdateDownload(update, options); staged = {update, download}; transfer = {status: "downloaded", ...identity};}
    catch {transfer = {status: "download-failed", ...identity};}
    return view();
   })().finally(() => {pending = undefined;});
   return pending;
  },
  preparedDownload() {
   if (!staged || pending) throw new Error("UPDATE_NOT_DOWNLOADED");
   requireVerifiedUpdate(staged.update);
   return {update: staged.update, download: {...staged.download}};
  },
 };
}
