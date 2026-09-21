import {useEffect, useRef, useState} from "react";
import type {DesktopUpdateCheckState} from "./update-feed.js";
import "./credential-settings.css";
const messages = {
 unconfigured: "Las actualizaciones todavía no están habilitadas en esta versión.",
 idle: "Buscá una versión nueva de la aplicación.",
 checking: "Buscando actualizaciones…",
 current: "Tenés la versión más reciente del canal configurado.",
 failed: "No se pudo verificar una actualización. Reintentá más tarde.",
};
export function UpdateSettings() {
 const [state, setState] = useState<DesktopUpdateCheckState>({status: "idle"});
 const [ready, setReady] = useState(false), busy = useRef(false), mounted = useRef(false);
 useEffect(() => {
  let active = true; mounted.current = true;
  void window.harness.updateStatus().then(value => {if (active) setState(value);}).catch(() => {if (active) setState({status: "failed"});}).finally(() => {if (active) setReady(true);});
  return () => {active = false; mounted.current = false;};
 }, []);
 async function check() {
  if (busy.current || !ready || state.status === "unconfigured") return;
  busy.current = true; setState({status: "checking"});
  try {const value = await window.harness.checkUpdates(); if (mounted.current) setState(value);}
  catch {if (mounted.current) setState({status: "failed"});}
  finally {busy.current = false;}
 }
 return <details className="update-settings"><summary>Actualizaciones</summary>
  <p role="status">{!ready ? "Consultando disponibilidad…" : state.status === "available" ? `Disponible: ${state.version} (${state.channel === "stable" ? "estable" : "versión preliminar"}).` : messages[state.status]}</p>
  {state.status === "available" ? <p>La instalación desde la app aún no está habilitada.</p> : null}
  <button type="button" data-action="check-updates" disabled={!ready || state.status === "checking" || state.status === "unconfigured"} onClick={() => void check()}>Buscar actualizaciones</button>
 </details>;
}
