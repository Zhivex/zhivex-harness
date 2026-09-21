import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, Sparkles, X } from "lucide-react";
import type {
  DesktopContext,
  DesktopModelSelection,
  DesktopProvider,
} from "./bridge.js";

export function ModelSelector({
  context,
  providers,
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
          ? "Guardá la clave de este proveedor en Credenciales antes de seleccionarlo."
          : code.includes("WORK_ACTIVE")
            ? "Terminá o cancelá las tareas y aprobaciones pendientes del proyecto antes de cambiar de modelo."
            : "No se pudo cambiar el modelo. Se conserva la selección anterior; reabrí el proyecto si perdió la conexión.",
      );
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const choices = providers.filter((p) =>
    `${p.name} ${p.defaultModel}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="model-selector" aria-busy={saving}>
      <button
        type="button"
        ref={trigger}
        className="model-trigger secondary"
        data-action="open-models"
        aria-haspopup="dialog"
        aria-label={`Elegir modelo: ${current.model || "sin selección"}`}
        disabled={disabled || !context}
        onClick={() => dialog.current?.showModal()}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span>{current.model || "Elegir modelo"}</span>
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
            <span className="eyebrow">TU ASISTENTE, TU ELECCIÓN</span>
            <h2 id="model-dialog-title">Elegí el modelo</h2>
            <p>Se usará en los próximos mensajes de este proyecto.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cerrar selector de modelos"
            disabled={saving}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <label className="model-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Buscar modelos"
            placeholder="Buscar por modelo o proveedor"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="model-catalog">
          {choices.map((p) => (
            <button
              key={p.id}
              type="button"
              className="model-card"
              aria-pressed={
                draft.provider === p.id && draft.model === p.defaultModel
              }
              disabled={disabled || saving}
              onClick={() => {
                setDraft({ provider: p.id, model: p.defaultModel });
                setCustom(false);
                setError("");
              }}
            >
              <span className="model-card-provider">
                {p.name}
                {draft.provider === p.id && draft.model === p.defaultModel ? (
                  <Check size={16} aria-hidden="true" />
                ) : null}
              </span>
              <strong>{p.defaultModel}</strong>
              <span className="model-card-note">
                {p.support === "provisional"
                  ? "Soporte provisional"
                  : "Modelo predeterminado"}
              </span>
            </button>
          ))}
          {!choices.length ? (
            <p className="muted">
              No hay modelos que coincidan con tu búsqueda.
            </p>
          ) : null}
        </div>
        <details className="model-advanced">
          <summary>Configurar otro modelo</summary>
          <div className="model-fields">
            <label>
              Proveedor
              <select
                aria-label="Proveedor"
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
              Modelo
              <select
                aria-label="Modelo"
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
                <option value="__custom">Otro modelo…</option>
              </select>
            </label>
            {custom ? (
              <label className="custom-model">
                ID del modelo
                <input
                  aria-label="ID del modelo"
                  placeholder="ID habilitado en tu cuenta"
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
          La disponibilidad depende de tu cuenta y de las credenciales
          guardadas. Actual: {current.model}.
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
            Volver
          </button>
          {dirty ? (
            <button
              type="button"
              data-action="apply-model"
              disabled={disabled || saving || !draft.model.trim()}
              onClick={() => void apply()}
            >
              {saving ? "Cambiando…" : "Usar modelo"}
            </button>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
