import { useEffect, useState } from 'react';
import { api } from './api';

type Preview = { id:string; origin:string; digest:string; directory:string; expires:number; busy:boolean };
type Evidence = { source:{head:string;digest:string}|null; id:string; digest:string; createdAt:string; status:string; error?:string; stale:boolean; hasScreenshot:boolean; plan:unknown; feedback:{id:string;text:string}[] };
type Listing = {previews:Preview[];artifacts:Evidence[];agentVerification?:boolean};
type Review = {ticket:string;directory:string;digest:string;files:string[];bytes:number};
export function PreviewPanel({projectKey}:{projectKey:string}) {
  const [listing,setListing]=useState<Listing>({previews:[],artifacts:[]}),[directory,setDirectory]=useState('dist');
  const [review,setReview]=useState<Review>(),[ack,setAck]=useState(false),[browserAck,setBrowserAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [selector,setSelector]=useState('h1'),[expected,setExpected]=useState(''),[urlPath,setUrlPath]=useState('/');
  const [plan,setPlan]=useState<{preview:Preview;plan:{path:string;steps:{kind:'text';selector:string;text:string}[]}}>();
  const [selected,setSelected]=useState<Evidence>(),[screenshot,setScreenshot]=useState(''),[feedback,setFeedback]=useState('');
  const action=<T,>(action:string,values:Record<string,unknown>={})=>api<T>('workspace/preview',{action,projectKey,...values});
  const reload=async()=>setListing(await action<Listing>('list'));
  useEffect(()=>{
    const abort=new AbortController();
    const refresh=()=>void api<Listing>('workspace/preview',{action:'list',projectKey},{signal:abort.signal}).then(setListing).catch(e=>{if(!abort.signal.aborted)setError(String(e.message));});
    refresh();const timer=setInterval(refresh,10000);return()=>{abort.abort();clearInterval(timer);};
  },[projectKey]);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();await reload();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <section aria-label="Previews y evidencia" className="workspace-panel">
    <h3>Previews y evidencia</h3>
    <p>Vista estática aislada. Generá la salida web con los checks de Code o la terminal y seleccioná su carpeta. Cada preview conserva los archivos exactos revisados.</p>
    <label>Carpeta de salida <input value={directory} onChange={e=>{setDirectory(e.target.value);setReview(undefined);setAck(false);}} placeholder="dist" disabled={busy}/></label>
    <button disabled={busy} onClick={()=>void run(async()=>{setReview(await action<Review>('review',{directory}));setAck(false);})}>Revisar preview</button>
    {review&&<div role="region" aria-label="Revisión de preview"><p>Publicar {review.directory}: {review.files.length} archivos, {review.bytes} bytes, durante 30 minutos en un puerto local separado.</p><code>{review.digest}</code><pre>{review.files.join('\n')}</pre>
      <p>Los archivos seleccionados serán accesibles a procesos locales. No incluyas credenciales ni datos privados. Los scripts de la página se ejecutan en un navegador separado, sin acceso al token de Assistant.</p>
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>Revisé los archivos y autorizo esta publicación local</label>
      <button disabled={busy||!ack} onClick={()=>void run(async()=>{const ticket=review.ticket;setReview(undefined);setAck(false);await action('start',{ticket});})}>Iniciar preview</button>
    </div>}
    {listing.previews.map(p=><div key={p.id}><p>{p.directory} · {p.origin} · vence {new Date(p.expires).toLocaleTimeString()}</p><p>ID para el agente: <code>{p.id}</code></p><p>Revisión: <code>{p.digest}</code></p>
      <label>Ruta <input value={urlPath} onChange={e=>{setUrlPath(e.target.value);setPlan(undefined);}}/></label>
      <label>Selector visible <input value={selector} onChange={e=>{setSelector(e.target.value);setPlan(undefined);}}/></label>
      <label>Texto esperado <input value={expected} onChange={e=>{setExpected(e.target.value);setPlan(undefined);}}/></label>
      <button disabled={busy||p.busy||!expected.trim()} onClick={()=>{setPlan({preview:p,plan:{path:urlPath,steps:[{kind:'text',selector,text:expected}]}});setBrowserAck(false);}}>Revisar verificación</button>
      <button onClick={()=>{setPlan(undefined);void action('stop').then(reload).catch(e=>setError(String(e.message)));}}>Detener previews</button>
    </div>)}
    {plan&&<div role="region" aria-label="Revisión de navegador"><p>Autorizar navegador separado en {plan.preview.origin}, revisión {plan.preview.digest}. Sin navegación externa; captura de 1280 × 800; límite de 30 segundos.</p><pre>{JSON.stringify(plan.plan,null,2)}</pre>
      <label><input type="checkbox" checked={browserAck} onChange={e=>setBrowserAck(e.target.checked)}/>Autorizo este recorrido y guardar su captura</label>
      <button disabled={busy||!browserAck} onClick={()=>void run(async()=>{const request={origin:plan.preview.origin,previewId:plan.preview.id,digest:plan.preview.digest,plan:plan.plan};setPlan(undefined);setAck(false);await action('verify',{request});})}>Verificar y guardar evidencia</button>
    </div>}
    <p>{listing.agentVerification?'El agente puede proponer recorridos con clicks mediante preview_verify; cada recorrido pasa por las aprobaciones de Code.':'La verificación manual está disponible. Para usar preview_verify con el agente, abrí una tarea local nueva: los entornos anteriores conservan sus herramientas y aprobaciones.'}</p>
    {listing.artifacts.map(a=><div key={a.id}><button disabled={busy} onClick={()=>void run(async()=>{setSelected(a);setScreenshot('');setFeedback('');const detail=await action<{screenshot?:string}>('artifact',{id:a.id});setScreenshot(detail.screenshot??'');})}>{a.feedback.length?'Comentario':a.status==='passed'?'Verificado':a.status==='running'?'En curso':'Falló'} · {new Date(a.createdAt).toLocaleString()} · {a.stale?'Desactualizado o sin revisión verificable':'Coincide con el proyecto actual'}{a.feedback.length?' · Comentario':''}</button></div>)}
    {selected&&<div role="region" aria-label="Artefacto de verificación"><code>{selected.id}</code><p>{(listing.artifacts.find(a=>a.id===selected.id)??selected).stale?'Evidencia desactualizada: el proyecto cambió desde la publicación o su revisión no pudo verificarse.':'La captura corresponde a esta revisión del proyecto y de la salida web.'}</p><p>Git: {selected.source?.head??'Revisión no disponible'}</p><p>Revisión de salida: <code>{selected.digest}</code> · {new Date(selected.createdAt).toLocaleString()}</p><pre>{JSON.stringify(selected.plan,null,2)}</pre>{selected.error&&<p role="alert">{selected.error}. Si falta Chromium, instalalo con playwright install chromium en el entorno de Assistant.</p>}{screenshot&&<img src={'data:image/png;base64,'+screenshot} alt="Captura del recorrido verificado" style={{maxWidth:'100%'}}/>}{selected.feedback.map(f=><p key={f.id}>Referencia {f.id}: {f.text}</p>)}
      <label>Comentario sobre esta evidencia <textarea value={feedback} maxLength={2000} onChange={e=>setFeedback(e.target.value)}/></label><button disabled={busy||!feedback.trim()} onClick={()=>void run(async()=>{await action('feedback',{id:selected.id,digest:selected.digest,text:feedback});setFeedback('');})}>Guardar comentario vinculado</button>
    </div>}
    {busy&&<p role="status">Procesando…</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
