import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { StarIcon } from "@phosphor-icons/react";
import type { WebModelChoice } from "./contracts.js";
import { choiceKey, formatContext, formatCost, showsImages } from "./model-choice.js";
import { modelRows, pickerKeyAction, readModelPickerMemory, rememberModel, toggleFavorite, MODEL_PICKER_KEY, type ModelPickerMemory, type ModelRow, type PickerKeyFocus } from "./model-picker-state.js";

export function ModelPicker(props: {
  choices: WebModelChoice[];
  currentKey: string;
  currentLabel: string;
  configured: boolean;
  disabled: boolean;
  pendingReview: boolean;
  loading: boolean;
  unavailable: boolean;
  selectionError: string;
  open: boolean;
  workspaceKey?: string;
  configuredOnlyDefault?: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (choice: WebModelChoice) => void;
  favoriteToggle: { current: (() => void) | null };
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [configuredOnly, setConfiguredOnly] = useState(props.configuredOnlyDefault ?? true);
  const [unconfiguredOpen, setUnconfiguredOpen] = useState(false);
  const [memory, setMemory] = useState<ModelPickerMemory>({ favorites: [], recents: [], lastUsedByWorkspace: {} });
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  const rowOptions = (configuredOnly: boolean) =>
    props.workspaceKey ? { configuredOnly, workspaceKey: props.workspaceKey } : { configuredOnly };
  const matched = useMemo(
    () => modelRows(props.choices, memory, query.trim(), rowOptions(false)),
    [props.choices, memory, query, props.workspaceKey],
  );
  const showUnconfigured = !configuredOnly && (unconfiguredOpen || query.trim().length > 0);
  const shownRows = matched.filter(row => {
    const parked = row.section === "unconfigured" && row.group !== "Favorites" && row.group !== "Recent";
    if (configuredOnly) return row.choice.configured;
    return showUnconfigured || !parked;
  });
  const activeIndex = shownRows.length ? Math.min(active, shownRows.length - 1) : 0;
  const activeRow = shownRows[activeIndex];
  const hiddenMatches = configuredOnly ? matched.filter(row => !row.choice.configured && row.group !== "Favorites" && row.group !== "Recent").length : 0;
  useEffect(() => {
    setMemory(readModelPickerMemory(localStorage.getItem(MODEL_PICKER_KEY)));
  }, []);
  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setConfiguredOnly(props.configuredOnlyDefault ?? true);
    setUnconfiguredOpen(false);
    const next = modelRows(props.choices, memoryRef.current, "", rowOptions(props.configuredOnlyDefault ?? true));
    const index = next.findIndex(row => choiceKey(row.choice) === props.currentKey && !row.disabled);
    setActive(index >= 0 ? index : 0);
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [props.open]);
  useEffect(() => {
    if (!props.open || !activeRow) return;
    document.getElementById(activeRow.id)?.scrollIntoView({ block: "nearest" });
  }, [props.open, activeRow?.id]);
  function persist(next: ModelPickerMemory) {
    setMemory(next);
    localStorage.setItem(MODEL_PICKER_KEY, JSON.stringify(next));
  }
  function apply(row: ModelRow | undefined) {
    if (!row || row.disabled) return;
    persist(rememberModel(memory, choiceKey(row.choice), props.workspaceKey));
    props.onOpenChange(false);
    props.onApply(row.choice);
    buttonRef.current?.focus();
  }
  props.favoriteToggle.current = () => {
    if (!props.open || !activeRow) return;
    persist(toggleFavorite(memory, choiceKey(activeRow.choice)));
  };
  function onKey(event: ReactKeyboardEvent, focus: PickerKeyFocus, index = activeIndex) {
    const action = pickerKeyAction(event.key, index, shownRows.length, focus);
    if (!action) return;
    if (action.type === "index") {
      event.preventDefault();
      setActive(action.index);
      if (focus === "star") document.getElementById(shownRows[action.index]?.id ?? "")?.querySelector("button")?.focus();
      return;
    }
    if (action.type === "apply") { event.preventDefault(); apply(shownRows[index]); return; }
    if (action.type === "close") {
      event.preventDefault();
      event.stopPropagation();
      props.onOpenChange(false);
      buttonRef.current?.focus();
      return;
    }
    if (action.type === "star") {
      event.preventDefault();
      document.getElementById(shownRows[index]?.id ?? "")?.querySelector("button")?.focus();
      return;
    }
    if (action.type === "search") { event.preventDefault(); searchRef.current?.focus(); }
  }
  const providerCount = new Set(props.choices.map(choice => choice.provider)).size;
  const topRows = shownRows.filter(row => row.section === "configured" || row.group === "Favorites" || row.group === "Recent");
  const bottomRows = shownRows.filter(row => row.section === "unconfigured" && row.group !== "Favorites" && row.group !== "Recent");
  const unconfiguredProviders = new Set(matched.filter(row => row.section === "unconfigured" && row.group !== "Favorites" && row.group !== "Recent").map(row => row.group)).size;
  return <div className="model-picker">
    <button id="model-choice" ref={buttonRef} type="button" className="model-button" aria-label="Provider and model"
      aria-haspopup="listbox" aria-expanded={props.open} aria-controls={props.open ? listId : undefined}
      disabled={props.disabled || props.loading || !props.choices.length}
      data-value={props.currentKey}
      onClick={() => props.onOpenChange(!props.open)}>
      <span>{props.configured ? props.currentLabel : `${props.currentLabel.split(" · ")[0]} · No credentials`}</span>
      <span aria-hidden="true">▾</span>
    </button>
    <p className="model-help" id="model-help">
      {props.loading ? "Reading configured providers and model choices…"
        : props.unavailable ? "Model choices unavailable. Reconnect to refresh."
        : !props.choices.length ? "Using the host model. No selectable catalog is available."
        : props.pendingReview ? "Decide the pending review before changing the model."
        : "The model is used for the next tasks in this workspace."}
    </p>
    {props.selectionError && <p id="model-selection-error" className="model-error" role="alert">{props.selectionError}</p>}
    {props.open && <div className="model-popover" role="presentation" onMouseDown={event => {
      const target = event.target as HTMLElement;
      if (target.closest("input, button, summary, label, a")) return;
      event.preventDefault();
    }} onBlur={event => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      props.onOpenChange(false);
    }}>
      <div className="model-toolbar">
        <input ref={searchRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={activeRow ? activeRow.id : undefined} aria-label="Search models"
          placeholder={`Search by model or provider · ${props.choices.length} models, ${providerCount} providers`}
          value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => onKey(event, "search")} />
        <label className="configured-toggle">
          <input type="checkbox" checked={configuredOnly} onChange={event => { setConfiguredOnly(event.target.checked); setActive(0); }} />
          Configured only
        </label>
      </div>
      {shownRows.length === 0 ? <div className="model-empty" role="status">
        <p>{hiddenMatches > 0
          ? `No configured model matches ‘${query.trim()}’. Turn off Configured only to include other providers.`
          : `No model matches ‘${query.trim()}’. Try the provider name or clear the search.`}</p>
        {query.trim() ? <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear search</button> : null}
      </div> : <div id={listId} className="model-list" role="listbox" aria-label="Models">
        <ModelGroups rows={topRows} indexOf={row => shownRows.indexOf(row)} query={query.trim()} currentKey={props.currentKey} activeId={activeRow?.id} onActive={setActive} onApply={apply} onFavorite={key => persist(toggleFavorite(memory, key))} onKey={onKey} />
        {!configuredOnly && unconfiguredProviders > 0 ? <details className="model-unconfigured" open={showUnconfigured} onToggle={event => setUnconfiguredOpen(event.currentTarget.open)}>
          <summary>{unconfiguredProviders === 1 ? "1 provider without credentials" : `${unconfiguredProviders} providers without credentials`}</summary>
          <p className="model-unconfigured-hint">Configure credentials in the CLI.</p>
          <ModelGroups rows={bottomRows} indexOf={row => shownRows.indexOf(row)} query={query.trim()} currentKey={props.currentKey} activeId={activeRow?.id} onActive={setActive} onApply={apply} onFavorite={key => persist(toggleFavorite(memory, key))} onKey={onKey} />
        </details> : null}
      </div>}
      {props.choices.length > 0 && props.choices.every(choice => choice.validation === "unverified")
        ? <p className="model-footnote">These models are not verified in Zhivex.</p> : null}
      {props.choices.some(choice => choiceKey(choice) === props.currentKey) ? null
        : <p className="model-footnote">Current host model (not in the catalog).</p>}
    </div>}
  </div>;
}

function ModelGroups(props: {
  rows: ModelRow[];
  indexOf: (row: ModelRow) => number;
  query: string;
  currentKey: string;
  activeId: string | undefined;
  onActive: (index: number) => void;
  onApply: (row: ModelRow) => void;
  onFavorite: (key: string) => void;
  onKey: (event: ReactKeyboardEvent, focus: PickerKeyFocus, index: number) => void;
}) {
  const groups: string[] = [];
  for (const row of props.rows) if (!groups.includes(row.group)) groups.push(row.group);
  return <>
    {groups.map(group => <div key={group} role="group" aria-label={group}>
      <p className="model-group">{group}</p>
      {props.rows.filter(row => row.group === group).map(row => {
        const meta = [formatContext(row.choice), formatCost(row.choice)].filter(Boolean).join(" · ");
        const current = choiceKey(row.choice) === props.currentKey;
        return <div key={row.id} id={row.id} role="option" aria-selected={row.id === props.activeId} aria-disabled={row.disabled || undefined}
          data-active={row.id === props.activeId ? "true" : "false"} data-current={current ? "true" : "false"}
          className="model-option"
          onMouseEnter={() => props.onActive(props.indexOf(row))}
          onClick={() => props.onApply(row)}>
          <span className="model-option-name">
            {current ? <span className="model-current" aria-hidden="true">✓</span> : null}
            <Highlight text={row.choice.name} query={props.query} />
          </span>
          <span className="model-option-chips">
            {showsImages(row.choice) ? <span className="capability">Images</span> : null}
          </span>
          <span className="model-option-meta" title={meta}>{meta}</span>
          <button type="button" className={row.favorite ? "star on" : "star"} aria-label={row.favorite ? `Remove ${row.choice.name} from favorites` : `Add ${row.choice.name} to favorites`}
            aria-pressed={row.favorite} onClick={event => { event.stopPropagation(); props.onFavorite(choiceKey(row.choice)); }}
            onKeyDown={event => props.onKey(event, "star", props.indexOf(row))}>
            <StarIcon size={16} weight={row.favorite ? "fill" : "regular"} aria-hidden="true" />
          </button>
        </div>;
      })}
    </div>)}
  </>;
}

function Highlight(props: { text: string; query: string }) {
  if (!props.query) return <>{props.text}</>;
  const index = props.text.toLowerCase().indexOf(props.query.toLowerCase());
  if (index < 0) return <>{props.text}</>;
  return <>{props.text.slice(0, index)}<mark>{props.text.slice(index, index + props.query.length)}</mark>{props.text.slice(index + props.query.length)}</>;
}
