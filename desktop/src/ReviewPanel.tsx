import {useEffect,useState} from "react";
import type {TicketedApprovalReview} from "./review-tickets.js";
export function ReviewPanel({projectKey,sessionId,runId,revision}:{projectKey:string;sessionId:string;runId:string;revision:number}){
 const [review,setReview]=useState<TicketedApprovalReview>(),[error,setError]=useState(false),[loading,setLoading]=useState(false);
 useEffect(()=>{setReview(undefined);setError(false);},[projectKey,sessionId,runId,revision]);
 async function decide(approve:boolean){if(!review||loading)return;setLoading(true);setError(false);try{const result=await window.harness.resolveReview(projectKey,review.ticketId,approve);setReview(undefined);if(!result.ok)setError(true);}catch{setReview(undefined);setError(true);}finally{setLoading(false);}}
 async function load(){setLoading(true);setError(false);try{setReview(await window.harness.review(projectKey,sessionId,runId));}catch{setError(true);}finally{setLoading(false);}}
 return <section className="review-panel" aria-label="Revisión de solicitud"><button type="button" className="secondary" data-action="review" disabled={loading} onClick={()=>void load()}>{loading?"Cargando revisión…":"Revisar solicitud"}</button>
 {error?<p role="alert">No se pudo recuperar la revisión. Actualizá la conversación antes de reintentar.</p>:null}
 {review?<><p className="status">Run {review.runId} · revisión {review.revision}</p>{review.items.map(item=><article key={item.approvalId} data-review-item={item.approvalId}>
 <h3>{item.name}</h3><p>{item.consequence}</p><p className="status">Aprobación {item.approvalId} · vence {new Date(item.expiresAt).toLocaleString()}</p>
 {!item.complete?<p role="alert">Revisión incompleta ({item.restriction}). No aprobar desde esta vista.</p>:null}
 {item.files.map((file,index)=><div key={index} className="review-file"><h4>{file.path}</h4><p className="status">Base: {file.expectedDigest??"archivo nuevo"}</p><p>{file.view==="literal-replacement"?"Reemplazo literal: fragmentos exactos; no representa el archivo completo.":"Contenido de destino completo; la base está vinculada por su digest."}</p>{file.before!==undefined?<pre className="removed">{file.before}</pre>:null}{file.after!==undefined?<pre className="added">{file.after}</pre>:null}</div>)}
 {item.commands.map((cmd,index)=><pre key={index} aria-label="Comando revisado">{cmd}</pre>)}
 <details><summary>Argumentos completos · {item.payloadDigest}</summary><pre>{item.payload}</pre></details>
 </article>)}<p>La decisión abarca todas las solicitudes mostradas. Rechazar impide estas operaciones; el agente puede continuar con otra propuesta.</p><button type="button" data-action="approve-review" disabled={loading||!review.canApprove} onClick={()=>void decide(true)}>Aprobar solicitudes revisadas</button><button type="button" className="secondary" data-action="deny-review" disabled={loading||!review.items.length} onClick={()=>void decide(false)}>Rechazar solicitudes</button>{!review.canApprove?<p>La aprobación desde esta vista está disponible solo para checks completos. Los cambios de archivos requieren el visor de base completa pendiente de implementación.</p>:null}</>:null}
 </section>;
}
