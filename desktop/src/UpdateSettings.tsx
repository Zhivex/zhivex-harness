import {useEffect, useRef, useState} from "react";
import type {DesktopUpdateState} from "./update-session.js";
import "./credential-settings.css";
const messages = {
 unconfigured: "Las actualizaciones todavía no están habilitadas en esta versión.",
 idle: "Buscá una versión nueva de la aplicación.",
 checking: "Buscando actualizaciones…",
 current: "Tenés la versión más reciente del canal configurado.",
 downloading: "Descargando y verificando la actualización… Podés seguir trabajando.",
 downloaded: "Descarga verificada. La instalación desde la app todavía está pendiente de habilitación.",
 "download-failed": "No se pudo completar la descarga. Podés reintentar.",
 failed: "No se pudo verificar una actualización. Reintentá más tarde.",
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
  if (state.status !== "checking" && state.status !== "downloading") return;
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
 async function check(download = false) {
  if (busy.current || !ready || state.status === "unconfigured") return;
  busy.current = true;
  if (download && (state.status === "available" || state.status === "download-failed")) setState({...state, status: "downloading"});
  else setState({status: "checking"});
  try {const value = await (download ? window.harness.downloadUpdate() : window.harness.checkUpdates()); if (mounted.current) setState(value);}
  catch {if (mounted.current) setState({status: "failed"});}
  finally {busy.current = false;}
 }
 return <details className="update-settings"><summary>Actualizaciones</summary>
  <p role="status">{!ready ? "Consultando disponibilidad…" : state.status === "available" ? `Disponible: ${state.version} (${state.channel === "stable" ? "estable" : "versión preliminar"}).` : messages[state.status]}</p>
  {state.status === "available" || state.status === "download-failed" ? <button type="button" data-action="download-update" onClick={() => void check(true)}>Descargar actualización</button> : null}
  <button type="button" data-action="check-updates" disabled={!ready || state.status === "checking" || state.status === "downloading" || state.status === "unconfigured"} onClick={() => void check()}>Buscar actualizaciones</button>
 </details>;
}
