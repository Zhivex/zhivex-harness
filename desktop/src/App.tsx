import { useEffect, useRef, useState } from "react";
import type { DesktopContext } from "./bridge.js";
import type { HarnessClientResponse, HarnessClientRun, HarnessClientSession } from "../../src/client-contract.js";
import type { HarnessActivityPage } from "../../src/service-events.js";

export function App() {
 const [context,setContext]=useState<DesktopContext>();
 const [session,setSession]=useState<HarnessClientSession>();
 const [run,setRun]=useState<HarnessClientRun>();
 const [text,setText]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 const cursor=useRef(0),activeRun=useRef<string|undefined>(undefined);
 useEffect(()=>{let valid=true;window.harness.context().then(value=>{if(valid)setContext(value);},()=>{if(valid)setError("No se pudo conectar al servicio.");});return()=>{valid=false;};},[]);
 useEffect(()=>{
  if(!session)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{
   const page=await window.harness.events(session.sessionId,cursor.current) as HarnessActivityPage;
   if(stopped)return;
   cursor.current=page.nextCursor;
   if(page.cursorExpired){setError("Actividad anterior expirada. Volvé a consultar la sesión.");}
   else {let delta="";for(const event of page.events){activeRun.current=event.runId;if(typeof event.activity.textDelta==="string")delta+=event.activity.textDelta;}if(delta)setText(t=>(t+delta).slice(-262144));}
  }catch{if(!stopped)setError("Conexión interrumpida. La ejecución conserva su estado en el servicio.");}
  if(!stopped)timer=setTimeout(poll,100);};void poll();return()=>{stopped=true;clearTimeout(timer);};
 },[session?.sessionId]);
 async function command(value:Record<string,unknown>) {
  const response=await window.harness.command(value) as HarnessClientResponse;
  if(!response.ok)throw new Error(response.error.code);
  return response.data;
 }
 async function start(prompt:string) {
  setBusy(true);setError("");setRun(undefined);activeRun.current=undefined;
  try{
   let current=session;
   if(!current){const created=await command({method:"session.create",idempotencyKey:crypto.randomUUID(),title:"Validación del escritorio"});if(created.kind!=="session")throw new Error();current=created.session;setSession(current);}
   const fresh=await command({method:"session.get",sessionId:current.sessionId});if(fresh.kind!=="session")throw new Error();
   const result=await command({method:"run.start",sessionId:current.sessionId,expectedRevision:fresh.session.revision,idempotencyKey:crypto.randomUUID(),prompt});
   if(result.kind!=="run")throw new Error();setRun(result.run);setSession(result.session);
  }catch{setError("No se pudo completar. Consultá el estado antes de volver a enviar.");}finally{setBusy(false);}
 }
 async function cancel(){try{
  if(!session||!activeRun.current)return;
  const current=await command({method:"run.get",sessionId:session.sessionId,runId:activeRun.current});if(current.kind!=="run")throw new Error();
  await command({method:"run.cancel",sessionId:session.sessionId,runId:current.run.runId,expectedRevision:current.run.revision,idempotencyKey:crypto.randomUUID()});
 }catch{setError("La cancelación recibió un conflicto; consultá el estado actual.");}}
 return <main data-ready={Boolean(context)}>
  <aside><div className="brand">◈ ZHIVEX <span>HARNESS</span></div><div className="phase">DESKTOP / SPIKE</div><p className="muted">Proyecto conectado</p><p className="workspace">{context?.workspace??"Conectando…"}</p><div className="connection">● {context?"Servicio local conectado":"Esperando al servicio"}</div><p className="muted runtime">Runtime Node {context?.runtimeNode??"…"}<br/>Proceso {context?.runtimePid??"…"}</p></aside>
  <section><header><div><span className="eyebrow">VALIDACIÓN DE ARQUITECTURA</span><h1>Una tarea. Un motor compartido.</h1></div><span className="badge">{context?.fixture?"Modelo offline":"Proveedor del host"}</span></header>
  <div className="conversation"><div className="welcome"><span className="symbol">◈</span><h2>El contexto se queda en tu proyecto.</h2><p>La interfaz conversa con el servicio. Las herramientas, las aprobaciones y el estado durable pertenecen al motor.</p></div>
  {text?<pre aria-label="Respuesta del servicio">{text}</pre>:null}
  {run?<p role="status" className="status">Estado: {run.status} · {run.runId}</p>:null}
  {error?<p role="alert" className="error">{error}</p>:null}</div>
  <footer><p>Prueba local del contrato · SQLite · cancelación · renderer aislado</p><div className="actions"><button data-action="start" disabled={!context||busy} onClick={()=>void start("Describe the local runtime connection.")}>Probar conversación <span>↗</span></button><button className="secondary" data-action="wait" disabled={!context||busy||!context.fixture} onClick={()=>void start("wait-for-cancel")}>Probar espera</button><button className="secondary" data-action="cancel" disabled={!busy||!activeRun.current} onClick={()=>void cancel()}>Cancelar</button></div></footer>
  </section>
 </main>;
}
