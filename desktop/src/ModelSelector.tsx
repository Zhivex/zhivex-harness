import { useEffect, useRef, useState } from "react";
import type { DesktopContext, DesktopModelSelection, DesktopProvider } from "./bridge.js";

export function ModelSelector({context, providers, disabled, changed, editing}: {
    context: DesktopContext | undefined; providers: DesktopProvider[]; disabled: boolean;
    editing: (value: boolean) => void;
    changed: (context: DesktopContext) => void;
}) {
    const current = context?.modelSelection ?? {provider:"openai",model:providers.find(p=>p.id==="openai")?.defaultModel ?? ""};
    const [draft,setDraft] = useState<DesktopModelSelection>(current);
    const [custom,setCustom] = useState(false), [saving,setSaving] = useState(false), [error,setError] = useState("");
    const pending = useRef(false), mounted = useRef(true);
    useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
    const provider = providers.find(p=>p.id===draft.provider);
    const models = [...new Set([provider?.defaultModel,...(current.provider===draft.provider?[current.model]:[])].filter((m):m is string=>Boolean(m)))];
    const dirty = draft.provider !== current.provider || draft.model !== current.model;
    useEffect(()=>{editing(dirty||saving);return()=>editing(false);},[dirty,saving,editing]);
    async function apply() {
        if (!context || pending.current || disabled || !draft.model.trim()) return;
        pending.current=true;setSaving(true);setError("");
        try { const next = await window.harness.selectModel(context.project.key,draft); if(mounted.current) changed(next); }
        catch (error) {
            const code = error instanceof Error ? error.message : "";
            setError(code.includes("CREDENTIAL") ? "Guardá la clave de este proveedor en Credenciales antes de seleccionarlo." : code.includes("WORK_ACTIVE") ? "Terminá o cancelá las tareas y aprobaciones pendientes del proyecto antes de cambiar de modelo." : "No se pudo cambiar el modelo. Se conserva la selección anterior; reabrí el proyecto si perdió la conexión.");
        } finally {pending.current=false;setSaving(false);}
    }
    return <div className="model-selector" aria-busy={saving}>
        <div className="model-fields">
            <label>Proveedor<select aria-label="Proveedor" data-action="select-provider" value={draft.provider} disabled={disabled||saving||!context} onChange={e=>{const p=providers.find(p=>p.id===e.target.value);if(p){setDraft({provider:p.id,model:p.defaultModel});setCustom(false);setError("");}}}>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Modelo<select aria-label="Modelo" data-action="select-model" value={custom?"__custom":draft.model} disabled={disabled||saving||!context} onChange={e=>{if(e.target.value==="__custom"){setCustom(true);}else{setCustom(false);setDraft({...draft,model:e.target.value});}setError("");}}>{models.map(m=><option key={m} value={m}>{m}</option>)}<option value="__custom">Otro modelo…</option></select></label>
            {custom?<label className="custom-model">ID del modelo<input aria-label="ID del modelo" placeholder="ID habilitado en tu cuenta" value={draft.model} maxLength={160} disabled={disabled||saving} onChange={e=>setDraft({...draft,model:e.target.value})}/></label>:null}
            {dirty?<button type="button" data-action="apply-model" className="secondary" disabled={disabled||saving||!draft.model.trim()} onClick={()=>void apply()}>{saving?"Cambiando…":"Usar modelo"}</button>:null}
        </div>
        <p className="model-hint">{context?.credentialConfigured===false&&!dirty?"Configurá la clave de este proveedor en Credenciales para enviar mensajes.":dirty?`El cambio se aplicará a los próximos mensajes de este proyecto. Actual: ${current.model}.`:provider?.support==="provisional"?"Soporte provisional. La disponibilidad depende de tu cuenta.":"Modelo del proyecto · podés cambiarlo cuando no haya tareas pendientes."}</p>
        {error?<p role="alert" className="error">{error}</p>:null}
    </div>;
}
