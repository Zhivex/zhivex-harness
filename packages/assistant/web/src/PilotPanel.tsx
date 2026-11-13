import {useState} from 'react';
import {api} from './api';
type Report={checks:{id:string;status:string;required:boolean;detail:string}[];architecture:string;platform:string};
export function PilotPanel(){
 const [report,setReport]=useState<Report>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <details><summary>Piloto local y compatibilidad</summary><p>La transición es gradual. Code sigue disponible; no se importa ni convierte una historia al abrir un proyecto.</p><button disabled={busy} onClick={()=>{setBusy(true);setError('');void api<Report>('pilot').then(setReport).catch(e=>setError(String(e.message))).finally(()=>setBusy(false));}}>Comprobar requisitos</button>
 {busy&&<p role="status">Comprobando requisitos locales…</p>}{error&&<p role="alert">{error}</p>}
 {report&&<><p>{report.platform} · {report.architecture} · Piloto local, sin actualización automática.</p><ul>{report.checks.map(check=><li key={check.id}><strong>{check.status==='available'?'Disponible':check.status==='missing'?'Falta':'Sin verificar'}{check.required?' · necesario':''}</strong>: {check.detail}</li>)}</ul></>}
 <p>Para traer historia, usá el preflight del piloto con un backup exportado por Code, después de cerrar su dueño original. Las identidades incompatibles se conservan allí. Las claves se vuelven a conectar desde el llavero; no se copian con el historial.</p><p>La distribución de producción queda pendiente de firma, notarización, actualizaciones confiables y recuperación verificada.</p></details>;
}
