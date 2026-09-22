import { modelDescription } from "../../src/internal/desktop/providers.js";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, Sparkles, X } from "lucide-react";
import type {
  DesktopContext,
  DesktopModelSelection,
  DesktopProvider,
} from "./bridge.js";

export function ModelSelector({
  context,
  providers: initialProviders,
  disabled,
  changed,
  editing,
}: {
  context: DesktopContext | undefined;
  providers: DesktopProvider[];
  disabled: boolean;
  editing: (value: boolean) => void;
  changed: (context: DesktopContext) => void;
}) {
  const [providers, setProviders] = useState(initialProviders);
  useEffect(() => setProviders(initialProviders), [initialProviders]);
  const current = context?.modelSelection ?? {
    provider: "openai",
    model: providers.find((p) => p.id === "openai")?.defaultModel ?? "",
  };
  const [draft, setDraft] = useState<DesktopModelSelection>(current);
  const [custom, setCustom] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const provider = providers.find((p) => p.id === draft.provider);
  const models = [
    ...new Set(
      [
        provider?.defaultModel,
        ...(provider?.models?.map(m => m.id) ?? []),
        ...(current.provider === draft.provider ? [current.model] : []),
      ].filter((m): m is string => Boolean(m)),
    ),
  ];
  const dirty =
    draft.provider !== current.provider || draft.model !== current.model;
  useEffect(() => {
    editing(dirty || saving);
    return () => editing(false);
  }, [dirty, saving, editing]);
  function close() {
    if (pending.current) return;
    dialog.current?.close();
    trigger.current?.focus();
    setDraft(current);
    setCustom(false);
    setError("");
    setQuery("");
  }
  async function apply() {
    if (!context || pending.current || disabled || !draft.model.trim()) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const next = await window.harness.selectModel(context.project.key, draft);
      if (mounted.current) {
        dialog.current?.close();
        changed(next);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLButtonElement>('[data-action="open-models"]')
            ?.focus(),
        );
      }
    } catch (error) {
      if (!mounted.current) return;
      const code = error instanceof Error ? error.message : "";
      setError(
        code.includes("CREDENTIAL")
          ? "Save this provider's key in Credentials before selecting it."
          : code.includes("WORK_ACTIVE")
            ? "Finish or cancel the project's pending tasks and approvals before changing models."
            : "Could not change the model. The previous selection is preserved; reopen the project if it lost its connection.",
      );
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const choices = providers.flatMap(p => (p.models ?? [{id:p.defaultModel, name:p.defaultModel,
    group:"primary" as const, order:0, lifecycle:"unknown" as const, validation:"unverified" as const, capabilities:[]}])
    .map(model => ({...model, provider:p.id, providerName:p.name})))
    .filter(m => `${m.providerName} ${m.name} ${m.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const renderCards = (group: "primary" | "other") => choices.filter(m => m.group === group).map(m => (
    <button key={`${m.provider}:${m.id}`} type="button" className="model-card"
      aria-pressed={draft.provider === m.provider && draft.model === m.id}
      disabled={disabled || saving}
      onClick={() => {setDraft({provider:m.provider, model:m.id});setCustom(false);setError("");}}>
      <span className="model-card-provider">{m.providerName}
        {draft.provider === m.provider && draft.model === m.id ? <Check size={16} aria-hidden="true" /> : null}
      </span>
      <strong>{m.name}</strong>
      {m.name !== m.id ? <span>{m.id}</span> : null}
      <span className="model-card-note">{modelDescription(m)}</span>
    </button>
  ));
  return (
    <div className="model-selector" aria-busy={saving}>
      <button
        type="button"
        ref={trigger}
        className="model-trigger secondary"
        data-action="open-models"
        aria-haspopup="dialog"
        aria-label={`Choose model: ${current.model || "no selection"}`}
        disabled={disabled || !context}
        onClick={() => {
          dialog.current?.showModal();
          void window.harness.providers().then(next => {if (mounted.current) setProviders(next);}).catch(() => {});
        }}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span>{current.model || "Choose model"}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        className="model-dialog"
        aria-labelledby="model-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">YOUR ASSISTANT, YOUR CHOICE</span>
            <h2 id="model-dialog-title">Choose a model</h2>
            <p>It will be used for subsequent messages in this project.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close model selector"
            disabled={saving}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <label className="model-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search models"
            placeholder="Search by model or provider"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <h3>Primary models</h3>
        <div className="model-catalog">{renderCards("primary")}</div>
        <details className="model-others" open={query ? true : undefined}>
          <summary>Other models ({choices.filter(m => m.group === "other").length})</summary>
          <div className="model-catalog">{renderCards("other")}</div>
        </details>
        {!choices.length ? <p className="muted">No models match your search.</p> : null}
        {providers.some(p => p.catalogStale) ? <p className="muted">Catalog update unavailable. Showing the last valid catalog.</p> : null}
        <details className="model-advanced">
          <summary>Configure another model</summary>
          <div className="model-fields">
            <label>
              Provider
              <select
                aria-label="Provider"
                data-action="select-provider"
                value={draft.provider}
                disabled={disabled || saving || !context}
                onChange={(e) => {
                  const p = providers.find((p) => p.id === e.target.value);
                  if (p) {
                    setDraft({ provider: p.id, model: p.defaultModel });
                    setCustom(false);
                    setError("");
                  }
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select
                aria-label="Model"
                data-action="select-model"
                value={custom ? "__custom" : draft.model}
                disabled={disabled || saving || !context}
                onChange={(e) => {
                  if (e.target.value === "__custom") setCustom(true);
                  else {
                    setCustom(false);
                    setDraft({ ...draft, model: e.target.value });
                  }
                  setError("");
                }}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom">Other model…</option>
              </select>
            </label>
            {custom ? (
              <label className="custom-model">
                Model ID
                <input
                  aria-label="Model ID"
                  placeholder="ID enabled for your account"
                  value={draft.model}
                  maxLength={160}
                  disabled={disabled || saving}
                  onChange={(e) =>
                    setDraft({ ...draft, model: e.target.value })
                  }
                />
              </label>
            ) : null}
          </div>
        </details>
        <p className="model-hint">
          Availability depends on your account and saved credentials. Current: {current.model}. Catalog: {providers[0]?.catalogRevision ?? "bundled"}.
        </p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={close}
          >
            Back
          </button>
          {dirty ? (
            <button
              type="button"
              data-action="apply-model"
              disabled={disabled || saving || !draft.model.trim()}
              onClick={() => void apply()}
            >
              {saving ? "Switching…" : "Use model"}
            </button>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
