import { useEffect, useId, useMemo, useRef, useState } from "react";
import { StarIcon } from "@phosphor-icons/react";
import type { WebModelChoice } from "./contracts.js";
import { choiceKey, formatContext, formatCost, showsImages } from "./model-choice.js";
import {
  modelRows,
  nextTypeaheadIndex,
  readModelPickerMemory,
  rememberWorkspaceModel,
  setConfiguredOnly,
  toggleFavorite,
  unconfiguredProviderNames,
  MODEL_PICKER_KEY,
  type ModelPickerMemory,
  type ModelRow,
} from "./model-picker-state.js";

export function ModelPicker(props: {
  choices: WebModelChoice[];
  currentKey: string;
  currentLabel: string;
  configured: boolean;
  workspaceKey: string;
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
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [memory, setMemory] = useState<ModelPickerMemory>({ favorites: [], recents: [], configuredOnly: true, lastUsedByWorkspace: {} });
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const preferredKey = memory.lastUsedByWorkspace[props.workspaceKey];
  const rows = useMemo(
    () => modelRows(props.choices, memory, query.trim(), { configuredOnly: memory.configuredOnly, ...(preferredKey ? { preferredKey } : {}) }),
    [props.choices, memory, query, preferredKey],
  );
  const activeRow = rows[active];
  const unconfigured = unconfiguredProviderNames(props.choices);
  useEffect(() => {
    setMemory(readModelPickerMemory(localStorage.getItem(MODEL_PICKER_KEY)));
  }, []);
  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    const initial = rows.findIndex(row => choiceKey(row.choice) === props.currentKey && !row.disabled);
    setActive(Math.max(0, initial));
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [props.open]);
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [active, props.open]);
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
    persist(rememberWorkspaceModel(memory, props.workspaceKey, choiceKey(row.choice)));
    props.onOpenChange(false);
    props.onApply(row.choice);
    buttonRef.current?.focus();
  }
  props.favoriteToggle.current = () => {
    if (!props.open || !activeRow) return;
    persist(toggleFavorite(memory, choiceKey(activeRow.choice)));
  };
  function onTypeahead(key: string) {
    typeahead.current = (typeahead.current + key).slice(-32);
    clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = setTimeout(() => { typeahead.current = ""; }, 700);
    setActive(nextTypeaheadIndex(rows.map(row => row.choice.name), typeahead.current, active));
  }
  function onListKey(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(Math.max(0, rows.length - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); apply(activeRow); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onOpenChange(false); buttonRef.current?.focus(); }
    else if (event.key === "Tab") props.onOpenChange(false);
    else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onTypeahead(event.key);
    }
  }
  const readyGroups = [...new Set(rows.filter(row => row.section === "ready").map(row => row.group))];
  const credentialRows = rows.filter(row => row.section === "needs-credentials");
  const providerCount = new Set(props.choices.map(choice => choice.provider)).size;
  const buttonLabel = props.configured ? props.currentLabel : props.currentLabel.split(" · ")[0] ?? props.currentLabel;
  return <div className="model-picker">
    <button id="model-choice" ref={buttonRef} type="button" className="model-button" aria-label="Provider and model"
      aria-haspopup="listbox" aria-expanded={props.open} aria-controls={props.open ? listId : undefined}
      disabled={props.disabled || props.loading || !props.choices.length}
      data-value={props.currentKey}
      onClick={() => props.onOpenChange(!props.open)}>
      <span className="model-button-label" title={buttonLabel}>{buttonLabel}</span>
      {!props.configured ? <span className="capability">Not configured</span> : null}
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
      <div className="model-popover-bar">
        <input ref={searchRef} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={activeRow ? activeRow.id : undefined} aria-label="Search models"
          placeholder={`Search ${props.choices.length} models from ${providerCount} providers`}
          value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(active + 1);
              listRef.current?.focus();
            } else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1); }
            else if (event.key === "Home") { event.preventDefault(); setActive(0); }
            else if (event.key === "End") { event.preventDefault(); setActive(Math.max(0, rows.length - 1)); }
            else if (event.key === "Enter") { event.preventDefault(); apply(activeRow); }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onOpenChange(false); buttonRef.current?.focus(); }
            else if (event.key === "Tab") props.onOpenChange(false);
          }} />
        <button type="button" className="configured-toggle" role="switch" aria-checked={memory.configuredOnly}
          onClick={() => persist(setConfiguredOnly(memory, !memory.configuredOnly))}>
          Configured only
        </button>
      </div>
      {rows.length === 0 ? <div className="model-empty" role="status">
        <p>No model matches ‘{query.trim()}’. Try the provider name or clear the search.</p>
        <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear search</button>
      </div> : <div id={listId} ref={listRef} role="listbox" aria-label="Models" tabIndex={0} className="model-list" onKeyDown={onListKey}>
        {readyGroups.map(group => <div key={group} role="group" aria-label={group}>
          <p className="model-group">{group}</p>
          {rows.filter(row => row.group === group && row.section === "ready").map(row => <ModelOption key={row.id} row={row} query={query.trim()} active={rows.indexOf(row) === active} current={choiceKey(row.choice) === props.currentKey} onHover={() => setActive(rows.indexOf(row))} onApply={() => apply(row)} onFavorite={() => persist(toggleFavorite(memory, choiceKey(row.choice)))} />)}
        </div>)}
        {credentialRows.length > 0 && <div role="group" aria-label="Not configured" aria-describedby={hintId}>
          <p className="model-group">Not configured</p>
          {credentialRows.map(row => <ModelOption key={row.id} row={row} query={query.trim()} active={rows.indexOf(row) === active} current={choiceKey(row.choice) === props.currentKey} onHover={() => setActive(rows.indexOf(row))} onApply={() => apply(row)} onFavorite={() => persist(toggleFavorite(memory, choiceKey(row.choice)))} />)}
        </div>}
      </div>}
      {unconfigured.length > 0 && <p className="model-unconfigured" id={hintId}>Configure {unconfigured.join(", ")} in the CLI. Credentials stay on the host and are never entered here.</p>}
      {props.choices.length > 0 && props.choices.every(choice => choice.validation === "unverified")
        ? <p className="model-footnote">These models are not verified in Zhivex.</p> : null}
      {props.choices.some(choice => choiceKey(choice) === props.currentKey) ? null
        : <p className="model-footnote">Current host model (not in the catalog).</p>}
    </div>}
  </div>;
}

function ModelOption(props: {
  row: ModelRow;
  query: string;
  active: boolean;
  current: boolean;
  onHover: () => void;
  onApply: () => void;
  onFavorite: () => void;
}) {
  const { row } = props;
  const context = formatContext(row.choice);
  const cost = formatCost(row.choice);
  const meta = [context, cost].filter(Boolean).join(" · ");
  return <div id={row.id} role="option" aria-selected={props.current} aria-disabled={row.disabled || undefined}
    data-active={props.active ? "true" : "false"}
    className="model-option"
    onMouseEnter={props.onHover}
    onClick={props.onApply}>
    <span className="model-option-name" title={row.choice.name}>
      <Highlight text={row.choice.name} query={props.query} />
    </span>
    <span className="model-option-chips">
      {showsImages(row.choice) ? <span className="capability">Images</span> : null}
      {row.favorite ? <span className="sr-only">Favorite</span> : null}
    </span>
    <span className="model-option-meta" title={meta}>{meta}</span>
    <button type="button" className={row.favorite ? "star on" : "star"} aria-label={row.favorite ? `Remove ${row.choice.name} from favorites` : `Add ${row.choice.name} to favorites`}
      aria-pressed={row.favorite} onClick={event => { event.stopPropagation(); props.onFavorite(); }}>
      <StarIcon size={14} weight={row.favorite ? "fill" : "regular"} />
    </button>
  </div>;
}

function Highlight(props: { text: string; query: string }) {
  if (!props.query) return <>{props.text}</>;
  const index = props.text.toLowerCase().indexOf(props.query.toLowerCase());
  if (index < 0) return <>{props.text}</>;
  return <>{props.text.slice(0, index)}<mark>{props.text.slice(index, index + props.query.length)}</mark>{props.text.slice(index + props.query.length)}</>;
}
