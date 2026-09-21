import {useEffect, useRef, useState} from "react";
import type {DesktopUpdateState} from "./update-session.js";
import "./credential-settings.css";
const messages = {
 unconfigured: "Updates are not yet enabled in this version.",
 idle: "Check for a new version of the application.",
 checking: "Checking for updates…",
 current: "You have the latest version for the configured channel.",
 downloading: "Downloading and verifying the update… You can keep working.",
 downloaded: "Download verified. Install when you have finished your tasks; the app will restart.",
 "download-failed": "Could not complete the download. You can try again.",
 installing: "Preparing installation and backup…",
 restarting: "Restarting the application…",
 "work-active": "Work is active. Finish your tasks and try installing again.",
 "install-failed": "Could not prepare installation. Try again or check for another update.",
 "recovery-required": "The update requires recovery. Preserve your data and reopen the application.",
 failed: "Could not verify an update. Try again later.",
};
export function UpdateSettings() {
 const [state, setState] = useState<DesktopUpdateState>({status: "idle"});
 const [ready, setReady] = useState(false), busy = useRef(false), mounted = useRef(false);
 useEffect(() => {
  let active = true; mounted.current = true;
  void window.harness.updateStatus().then(value => {if (active) setState(value);}).catch(() => {if (active) setState({status: "failed"});}).finally(() => {if (active) setReady(true);});
  return () => {active = false; mounted.current = false;};
 }, []);
 useEffect(() => {
  if (state.status !== "checking" && state.status !== "downloading" && state.status !== "installing") return;
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
   try {const value = await window.harness.updateStatus(); if (active) setState(value);}
   catch {if (active) setState({status: "failed"});}
   if (active) timer = setTimeout(() => void poll(), 500);
  };
  timer = setTimeout(() => void poll(), 500);
  return () => {active = false; clearTimeout(timer);};
 }, [state.status]);
 async function check(action: "check" | "download" | "install" = "check") {
  if (busy.current || !ready || state.status === "unconfigured") return;
  busy.current = true;
  if (action === "install" && "version" in state) setState({...state, status: "installing"});
  else if (action === "download" && (state.status === "available" || state.status === "download-failed")) setState({...state, status: "downloading"});
  else setState({status: "checking"});
  try {const value = await (action === "install" ? window.harness.installUpdate() : action === "download" ? window.harness.downloadUpdate() : window.harness.checkUpdates()); if (mounted.current) setState(value);}
  catch {if (mounted.current) setState({status: "failed"});}
  finally {busy.current = false;}
 }
 return <details className="update-settings"><summary>Updates</summary>
  <p role="status">{!ready ? "Checking availability…" : state.status === "available" ? `Available: ${state.version} (${state.channel === "stable" ? "stable" : "prerelease"}).` : messages[state.status]}</p>
  {state.status === "available" || state.status === "download-failed" ? <button type="button" data-action="download-update" onClick={() => void check("download")}>Download update</button> : null}
  {["downloaded", "work-active", "install-failed"].includes(state.status) ? <button type="button" data-action="install-update" onClick={() => void check("install")}>Install and restart</button> : null}
  <button type="button" data-action="check-updates" disabled={!ready || state.status === "checking" || state.status === "downloading" || state.status === "installing" || state.status === "restarting" || state.status === "recovery-required" || state.status === "unconfigured"} onClick={() => void check()}>Check for updates</button>
 </details>;
}
