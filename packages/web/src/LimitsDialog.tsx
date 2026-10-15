import { useLayoutEffect, useRef, useState } from "react";
import { ClockIcon, CoinsIcon, InfoIcon, ListNumbersIcon, ShieldCheckIcon, WrenchIcon, XIcon, CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { emptyLimitSettings, limitNames, parseLimitInput, type LimitName, type LimitScope, type LimitSettings } from "./limit-settings.js";

const sections = [
  { id: "cost", title: "Estimated spend", description: "Set a spend threshold for this task.", names: ["costUsd"], Icon: CoinsIcon },
  { id: "tokens", title: "Tokens", description: "Set a token threshold for this task.", names: ["tokens"], Icon: ListNumbersIcon },
  { id: "work", title: "Steps and tools", description: "Set thresholds for steps and tools.", names: ["steps", "toolCalls"], Icon: WrenchIcon },
  { id: "time", title: "Duration", description: "Set an active-duration threshold.", names: ["durationMinutes"], Icon: ClockIcon },
] as const;
const labels: Record<LimitName, string> = { costUsd: "Amount in USD", tokens: "Total tokens", steps: "Steps", toolCalls: "Tool calls", durationMinutes: "Duration in minutes" };

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
      <h2 id="limits-title">Configure only what you need</h2>
      <button type="button" className="limits-close" aria-label="Close limits" disabled={saving} onClick={onCancel}><XIcon size={22} /></button>
      <p id="limits-description">{unboundedDefault ? "No cumulative caps by default." : "Set thresholds in addition to the host policy."}<br />Consumption follows your provider.</p>
    </div>
    <div className="limits-scopes" role="group" aria-label="Limit scope">
      {(["task", "project"] as const).map(s => <button type="button" key={s} aria-pressed={scope === s} disabled={saving}
        onClick={() => { setScope(s); setInvalid([]); }}>{s === "task" ? "Next task" : "Project"}</button>)}
    </div>
    <div className="limits-sections">
      {sections.map(({ id, title, description, names, Icon }) => <section key={id}>
        <button type="button" className="limits-section-toggle" aria-expanded={expanded === id} aria-controls={`limits-${id}`}
          onClick={() => setExpanded(expanded === id ? "" : id)}>
          <Icon size={24} weight="regular" /><span><strong>{title}</strong><small>{description}</small></span>
          <span className="limits-summary">{names.every(n => current[n].value === null) ? "No limit" : "Configured"}</span>
          {expanded === id ? <CaretUpIcon size={18} /> : <CaretDownIcon size={18} />}
        </button>
        <div className="limits-section-body" id={`limits-${id}`} hidden={expanded !== id}>
          {names.map(name => <fieldset key={name} disabled={saving}>
            {names.length > 1 && <legend>{labels[name]}</legend>}
            <label className="limits-enable"><input type="checkbox" checked={current[name].value !== null}
              disabled={name === "costUsd" && !pricingAvailable && current[name].value === null}
              onChange={event => update(name, event.target.checked)} />Set a threshold{names.length > 1 ? ` for ${name === "steps" ? "steps" : "tool calls"}` : ""}</label>
            <input className="limits-value" aria-label={labels[name]} placeholder={labels[name]} type="text" inputMode={name === "costUsd" || name === "durationMinutes" ? "decimal" : "numeric"}
              value={inputs[scope][name]} disabled={current[name].value === null || name === "costUsd" && !pricingAvailable} aria-invalid={invalid.includes(name)} aria-describedby={invalid.includes(name) ? `limits-error-${name}` : undefined}
              onChange={event => { setInputs(previous => ({ ...previous, [scope]: { ...previous[scope], [name]: event.target.value } })); setInvalid(previous => previous.filter(n => n !== name)); }} />
            {name === "costUsd" && <small className="limits-example">Format example: 5.00 USD</small>}
            {name === "costUsd" && !pricingAvailable && <p className="limits-example">This model has no estimated price. This threshold cannot be turned on; you can remove an earlier setting.</p>}
            {invalid.includes(name) && <p className="limits-error" id={`limits-error-${name}`} role="alert">Enter a valid positive{["tokens", "steps", "toolCalls"].includes(name) ? " whole" : ""} number.</p>}
            <label className="limits-action-label">When the threshold is reached</label>
            <div className="limits-actions" role="group" aria-label={`Action for ${labels[name]}`}>
              {(["notify", "stop"] as const).map(action => <button type="button" key={action} disabled={current[name].value === null}
                aria-pressed={current[name].action === action} onClick={() => setSettings(previous => ({ ...previous, [scope]: { ...previous[scope], [name]: { ...previous[scope][name], action } } }))}>{action === "notify" ? "Notify" : "Stop"}</button>)}
            </div>
          </fieldset>)}
        </div>
      </section>)}
    </div>
    <p className="limits-empty-note"><InfoIcon size={18} />Empty fields do not set limits.</p>
    <p className="limits-technical">{technicalNotice}</p>
    {error && <p className="limits-error" role="alert">{error}</p>}
    {limitNames.some(name => current[name].value !== null && current[name].action === "stop") &&
      <p className="limits-technical">Stop requests cancellation when the threshold is observed. It keeps recorded work and consumption; it does not undo actions. To continue, start another task with the available context. There is no automatic replay.</p>}
    {current.costUsd.value !== null && <p className="limits-technical">Spend is estimated from reported tokens. It can exceed the threshold; it is not a guaranteed financial cap.</p>}
    <footer className="limits-footer">
      <p>{scope === "task" ? "Applies to the next task." : "Applies to new tasks in this project."} It does not change consumption already recorded.</p>
      <div><span><ShieldCheckIcon size={18} />Permissions and the sandbox are managed separately.</span>
        <button type="button" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="limits-save" disabled={saving || saveBlocked} onClick={save}>{saving ? "Saving…" : "Save limits"}</button>
      </div>
    </footer>
  </dialog>;
}
