import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WebModelChoice } from "./contracts.js";
import { choiceKey, formatContext, formatCost, showsImages } from "./model-choice.js";
import { modelRows, providerCredentialNote, readModelPickerMemory, rememberModel, toggleFavorite, MODEL_PICKER_KEY, type ModelPickerMemory, type ModelRow } from "./model-picker-state.js";

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
  onOpenChange: (open: boolean) => void;
  onApply: (choice: WebModelChoice) => void;
  favoriteToggle: { current: (() => void) | null };
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [memory, setMemory] = useState<ModelPickerMemory>({ favorites: [], recents: [] });
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => modelRows(props.choices, memory, query.trim()), [props.choices, memory, query]);
  const activeRow = rows[active];
  useEffect(() => {
    setMemory(readModelPickerMemory(localStorage.getItem(MODEL_PICKER_KEY)));
  }, []);
  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setActive(Math.max(0, rows.findIndex(row => choiceKey(row.choice) === props.currentKey && !row.disabled)));
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [props.open]);
  function persist(next: ModelPickerMemory) {
    setMemory(next);
    localStorage.setItem(MODEL_PICKER_KEY, JSON.stringify(next));
  }
  function move(next: number) {
    if (!rows.length) return;
    setActive((next + rows.length) % rows.length);
  }
  function apply(row: ModelRow | undefined) {
    if (!row || row.disabled) return;
    persist(rememberModel(memory, choiceKey(row.choice)));
    props.onOpenChange(false);
    props.onApply(row.choice);
    buttonRef.current?.focus();
  }
  props.favoriteToggle.current = () => {
    if (!props.open || !activeRow) return;
    persist(toggleFavorite(memory, choiceKey(activeRow.choice)));
  };
  const groups = [...new Set(rows.map(row => row.group))];
  const providerCount = new Set(props.choices.map(choice => choice.provider)).size;
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
    {props.open && <div className="model-popover" role="presentation">
      <input ref={searchRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={activeRow ? activeRow.id : undefined} aria-label="Search models"
        placeholder={`Search ${props.choices.length} models from ${providerCount} providers`}
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
          else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
          else if (event.key === "Home") { event.preventDefault(); setActive(0); }
          else if (event.key === "End") { event.preventDefault(); setActive(Math.max(0, rows.length - 1)); }
          else if (event.key === "Enter") { event.preventDefault(); apply(activeRow); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onOpenChange(false); buttonRef.current?.focus(); }
          else if (event.key === "Tab") props.onOpenChange(false);
        }} />
      {rows.length === 0 ? <div className="model-empty" role="status">
        <p>No model matches ‘{query.trim()}’. Try the provider name or clear the search.</p>
        <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear search</button>
      </div> : <div id={listId} role="listbox" aria-label="Models">
        {groups.map(group => <div key={group} role="group" aria-label={group}>
          <p className="model-group">{group}{providerCredentialNote(props.choices, group) ? " · No credentials · configure them in the CLI" : ""}</p>
          {rows.filter(row => row.group === group).map(row => {
            const index = rows.indexOf(row);
            const current = choiceKey(row.choice) === props.currentKey;
            const detail = [
              showsImages(row.choice) ? "Images" : "",
              row.favorite ? "Favorite" : "",
              row.disabled ? "No credentials" : "",
            ].filter(Boolean).join(", ");
            return <div key={row.id} id={row.id} role="option" aria-selected={index === active} aria-disabled={row.disabled || undefined}
              className={index === active ? "model-option active" : "model-option"}
              onMouseEnter={() => setActive(index)}
              onClick={() => apply(row)}>
              <span className="model-option-main">
                {current ? <span aria-hidden="true">✓ </span> : null}
                <Highlight text={row.choice.name} query={query.trim()} />
                {row.choice.name !== row.choice.model ? <small>{row.choice.model}</small> : null}
              </span>
              <span className="model-option-meta">
                {showsImages(row.choice) ? <span className="capability">Images</span> : null}
                {formatContext(row.choice) ? <span>{formatContext(row.choice)}</span> : null}
                {formatCost(row.choice) ? <span>{formatCost(row.choice)}</span> : null}
                {row.disabled ? <span>No credentials</span> : null}
                <button type="button" className={row.favorite ? "star on" : "star"} aria-label={row.favorite ? `Remove ${row.choice.name} from favorites` : `Add ${row.choice.name} to favorites`}
                  aria-pressed={row.favorite} onClick={event => { event.stopPropagation(); persist(toggleFavorite(memory, choiceKey(row.choice))); }}>★</button>
              </span>
              <span className="sr-only">{detail}</span>
            </div>;
          })}
        </div>)}
      </div>}
      {props.choices.length > 0 && props.choices.every(choice => choice.validation === "unverified")
        ? <p className="model-footnote">These models are not verified in Zhivex.</p> : null}
      {props.choices.some(choice => choiceKey(choice) === props.currentKey) ? null
        : <p className="model-footnote">Current host model (not in the catalog).</p>}
    </div>}
  </div>;
}

function Highlight(props: { text: string; query: string }) {
  if (!props.query) return <>{props.text}</>;
  const index = props.text.toLowerCase().indexOf(props.query.toLowerCase());
  if (index < 0) return <>{props.text}</>;
  return <>{props.text.slice(0, index)}<mark>{props.text.slice(index, index + props.query.length)}</mark>{props.text.slice(index + props.query.length)}</>;
}
