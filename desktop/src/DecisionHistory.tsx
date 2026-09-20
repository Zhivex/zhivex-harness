import {useState} from "react";
import type {ApprovalDecisionView} from "../../src/approval-history.js";
const labels:Record<ApprovalDecisionView["status"],string>={rejected:"Rechazado",approved:"Aprobado · sin evidencia de ejecución",applied:"Aplicado",succeeded:"Completado",failed:"Fallido",unknown:"Resultado sin confirmar"};
export function DecisionHistory({projectKey,sessionId,runId}:{projectKey:string;sessionId:string;runId:string}){
 const [rows,setRows]=useState<ApprovalDecisionView[]>(),[next,setNext]=useState<number>(),[loading,setLoading]=useState(false),[error,setError]=useState(false);
 async function load(offset=0){setLoading(true);setError(false);try{const response=await window.harness.command(projectKey,{method:"run.get",sessionId,runId,decisionOffset:offset});if(!response.ok||response.data.kind!=="run")throw new Error();const incoming=response.data.run.decisions??[];setRows(previous=>offset===0?incoming:[...(previous??[]),...incoming]);setNext(response.data.run.decisionNextOffset);}catch{setError(true);}finally{setLoading(false);}}
 return <section className="decision-history" aria-label="Historial de decisiones"><button type="button" className="secondary" data-action="decision-history" disabled={loading} onClick={()=>void load()}>Historial de decisiones</button>
 {error?<p role="alert">No se pudo recuperar el historial. Reintentá la lectura.</p>:null}
 {rows?.length===0?<p>No hay decisiones registradas por este servicio para el run.</p>:null}
 {rows?.map(row=><article key={`${row.approvalId}:${row.digest}`} data-decision-status={row.status}>
 <h4>{row.name} · {labels[row.status]}</h4><p>Revisión {row.reviewedRevision} · {new Date(row.decidedAt).toLocaleString()}</p><p className="status">Aprobación {row.approvalId} · digest {row.digest}</p>
 {row.evidence?.proposalId?<p className="status">Parche aplicado: {row.evidence.proposalId}</p>:null}
 {row.evidence?.effects?.map((effect,i)=><p className="status" key={i}>{effect.path}<br/>Base: {effect.beforeDigest??"ausente"}<br/>Resultado: {effect.afterDigest??"ausente"}</p>)}
 {row.evidence?.exitCode!==undefined?<><p>Check · exit {row.evidence.exitCode}{row.evidence.timedOut?" · tiempo agotado":""}</p>{row.evidence.verifiedPatchId?<p className="status">Verificado para el parche {row.evidence.verifiedPatchId}<br/>{JSON.stringify(row.evidence.command)}</p>:<p>Este check no certifica un parche específico.</p>}</>:null}
 </article>)}
 {next!==undefined?<button type="button" className="secondary" disabled={loading} onClick={()=>void load(next)}>Ver más decisiones</button>:null}
 </section>;
}
