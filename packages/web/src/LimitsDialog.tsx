import { useLayoutEffect, useRef, useState } from "react";
import { ClockIcon, CoinsIcon, InfoIcon, ListNumbersIcon, ShieldCheckIcon, WrenchIcon, XIcon, CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { emptyLimitSettings, limitNames, parseLimitInput, type LimitName, type LimitScope, type LimitSettings } from "./limit-settings.js";

const sections = [
  { id: "cost", title: "Gasto estimado", description: "Define un umbral de gasto para esta tarea.", names: ["costUsd"], Icon: CoinsIcon },
  { id: "tokens", title: "Tokens", description: "Configura un umbral de tokens para esta tarea.", names: ["tokens"], Icon: ListNumbersIcon },
  { id: "work", title: "Pasos y herramientas", description: "Configura umbrales para pasos y herramientas.", names: ["steps", "toolCalls"], Icon: WrenchIcon },
  { id: "time", title: "Duración", description: "Configura un umbral de duración activa.", names: ["durationMinutes"], Icon: ClockIcon },
] as const;
const labels: Record<LimitName, string> = { costUsd: "Importe en USD", tokens: "Tokens totales", steps: "Pasos", toolCalls: "Llamadas a herramientas", durationMinutes: "Duración en minutos" };

/** Render only when the host exposes supported threshold behavior. */
export function LimitsDialog({ initial, onCancel, onSave, technicalNotice, saving = false, pricingAvailable = true, unboundedDefault = true, saveBlocked = false, error = "" }: {
  initial: Record<LimitScope, LimitSettings>;
  onCancel(): void;
  onSave(scope: LimitScope, settings: LimitSettings): void;
  technicalNotice: string;
  saving?: boolean;
  pricingAvailable?: boolean;
  unboundedDefault?: boolean;
  error?: string;
  saveBlocked?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<LimitScope>("task");
  const [settings, setSettings] = useState(() => structuredClone(initial));
  const [inputs, setInputs] = useState(() => Object.fromEntries(["task", "project"].map(s => [s,
    Object.fromEntries(limitNames.map(n => [n, initial[s as LimitScope][n].value?.toString() ?? ""])),
  ])) as Record<LimitScope, Record<LimitName, string>>);
  const [expanded, setExpanded] = useState("cost");
  const [invalid, setInvalid] = useState<LimitName[]>([]);
  useLayoutEffect(() => {
    const node = dialog.current!; node.showModal();
    return () => node.close();
  }, []);
  const current = settings[scope];
  function update(name: LimitName, enabled: boolean) {
    setInvalid(previous => previous.filter(n => n !== name));
    setSettings(previous => ({ ...previous, [scope]: { ...previous[scope], [name]: {
      ...previous[scope][name], value: enabled ? parseLimitInput(name, inputs[scope][name]) ?? 1 : null,
    } } }));
  }
  function save() {
    const result = emptyLimitSettings();
    const errors: LimitName[] = [];
    for (const name of limitNames) {
      const threshold = current[name];
      const value = threshold.value === null ? null : parseLimitInput(name, inputs[scope][name]);
      if (value === undefined) errors.push(name);
      result[name] = { ...threshold, value: value ?? null };
    }
    setInvalid(errors);
    if (errors.length) {
      setExpanded(sections.find(section => (section.names as readonly string[]).includes(errors[0]!))!.id);
      return;
    }
    if (JSON.stringify(result) === JSON.stringify(initial[scope])) onCancel();
    else onSave(scope, result);
  }
  return <dialog className="limits-dialog" ref={dialog} aria-labelledby="limits-title" aria-describedby="limits-description"
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")]
        .filter(node => node.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={event => { event.preventDefault(); if (!saving) onCancel(); }}>
    <div className="limits-heading">
      <h2 id="limits-title">Configura solo lo que necesites</h2>
      <button type="button" className="limits-close" aria-label="Cerrar límites" disabled={saving} onClick={onCancel}><XIcon size={22} /></button>
      <p id="limits-description">{unboundedDefault ? "Sin topes acumulativos por defecto." : "Configura umbrales adicionales a la política del host."}<br />Consumo según tu proveedor.</p>
    </div>
    <div className="limits-scopes" role="group" aria-label="Alcance de los límites">
      {(["task", "project"] as const).map(s => <button type="button" key={s} aria-pressed={scope === s} disabled={saving}
        onClick={() => { setScope(s); setInvalid([]); }}>{s === "task" ? "Próxima tarea" : "Proyecto"}</button>)}
    </div>
    <div className="limits-sections">
      {sections.map(({ id, title, description, names, Icon }) => <section key={id}>
        <button type="button" className="limits-section-toggle" aria-expanded={expanded === id} aria-controls={`limits-${id}`}
          onClick={() => setExpanded(expanded === id ? "" : id)}>
          <Icon size={24} weight="regular" /><span><strong>{title}</strong><small>{description}</small></span>
          <span className="limits-summary">{names.every(n => current[n].value === null) ? "Sin límite" : "Configurado"}</span>
          {expanded === id ? <CaretUpIcon size={18} /> : <CaretDownIcon size={18} />}
        </button>
        <div className="limits-section-body" id={`limits-${id}`} hidden={expanded !== id}>
          {names.map(name => <fieldset key={name} disabled={saving}>
            {names.length > 1 && <legend>{labels[name]}</legend>}
            <label className="limits-enable"><input type="checkbox" checked={current[name].value !== null}
              disabled={name === "costUsd" && !pricingAvailable && current[name].value === null}
              onChange={event => update(name, event.target.checked)} />Configurar un umbral{names.length > 1 ? ` de ${name === "steps" ? "pasos" : "herramientas"}` : ""}</label>
            <input className="limits-value" aria-label={labels[name]} placeholder={labels[name]} type="text" inputMode={name === "costUsd" || name === "durationMinutes" ? "decimal" : "numeric"}
              value={inputs[scope][name]} disabled={current[name].value === null || name === "costUsd" && !pricingAvailable} aria-invalid={invalid.includes(name)} aria-describedby={invalid.includes(name) ? `limits-error-${name}` : undefined}
              onChange={event => { setInputs(previous => ({ ...previous, [scope]: { ...previous[scope], [name]: event.target.value } })); setInvalid(previous => previous.filter(n => n !== name)); }} />
            {name === "costUsd" && <small className="limits-example">Ejemplo de formato: 5,00 USD</small>}
            {name === "costUsd" && !pricingAvailable && <p className="limits-example">Este modelo no tiene un precio estimado disponible. No se puede activar este umbral; puedes quitar una configuración anterior.</p>}
            {invalid.includes(name) && <p className="limits-error" id={`limits-error-${name}`} role="alert">Introduce un número positivo{["tokens", "steps", "toolCalls"].includes(name) ? " entero" : ""} válido.</p>}
            <label className="limits-action-label">Al alcanzar el umbral</label>
            <div className="limits-actions" role="group" aria-label={`Acción para ${labels[name]}`}>
              {(["notify", "stop"] as const).map(action => <button type="button" key={action} disabled={current[name].value === null}
                aria-pressed={current[name].action === action} onClick={() => setSettings(previous => ({ ...previous, [scope]: { ...previous[scope], [name]: { ...previous[scope][name], action } } }))}>{action === "notify" ? "Avisar" : "Detener"}</button>)}
            </div>
          </fieldset>)}
        </div>
      </section>)}
    </div>
    <p className="limits-empty-note"><InfoIcon size={18} />Los campos vacíos no establecen límites.</p>
    <p className="limits-technical">{technicalNotice}</p>
    {error && <p className="limits-error" role="alert">{error}</p>}
    {limitNames.some(name => current[name].value !== null && current[name].action === "stop") &&
      <p className="limits-technical">Detener solicita la cancelación al observar el umbral. Conserva el trabajo y consumo registrados; no revierte acciones. Para seguir, inicia otra tarea con el contexto disponible. No hay reenvío automático.</p>}
    {current.costUsd.value !== null && <p className="limits-technical">El gasto es estimado según tokens reportados. Puede superar el umbral; no es un tope financiero garantizado.</p>}
    <footer className="limits-footer">
      <p>{scope === "task" ? "Se aplicará a la próxima tarea." : "Se aplicará a nuevas tareas de este proyecto."} No cambia el consumo ya registrado.</p>
      <div><span><ShieldCheckIcon size={18} />Permisos y sandbox se gestionan por separado.</span>
        <button type="button" disabled={saving} onClick={onCancel}>Cancelar</button>
        <button type="button" className="limits-save" disabled={saving || saveBlocked} onClick={save}>{saving ? "Guardando…" : "Guardar límites"}</button>
      </div>
    </footer>
  </dialog>;
}
