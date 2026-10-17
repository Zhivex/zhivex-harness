import { useLayoutEffect, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";

export type ApprovalMode = "manual" | "auto-edits" | "auto-limits";
export interface ApprovalRecord {
  id: string;
  name: string;
  mode: ApprovalMode;
  reason: string;
  timestamp: string;
  paths: string[];
  undoable: boolean;
}

const modes: { id: ApprovalMode; label: string; detail: string }[] = [
  { id: "manual", label: "Manual", detail: "Every change waits for you. This is the default." },
  { id: "auto-edits", label: "Auto-edits", detail: "File edits inside this project are applied. Commands still wait." },
  { id: "auto-limits", label: "Auto with limits", detail: "Also runs commands on the workspace allowlist." },
];

/** Session choice wins until you leave. Workspace choice is saved in the protected project config. */
export function ApprovalModeDialog({ mode, records, saving, onClose, onSave, onUndo }: {
  mode: ApprovalMode;
  records: readonly ApprovalRecord[];
  saving: boolean;
  onClose(): void;
  onSave(scope: "session" | "workspace", mode: ApprovalMode): void;
  onUndo(id: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<"session" | "workspace">("session");
  const [choice, setChoice] = useState<ApprovalMode>(mode);
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog className="limits-dialog" ref={dialog} aria-labelledby="approval-title" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="limits-heading">
      <h2 id="approval-title">Approvals</h2>
      <button type="button" className="limits-close" aria-label="Close approvals" disabled={saving} onClick={onClose}><XIcon size={22} /></button>
      <p>Network, secrets, git push, package publish, writes outside this project, and anything over a limit always wait for you. Press m to return to Manual.</p>
    </div>
    <div className="limits-scopes" role="group" aria-label="Where this choice applies">
      <button type="button" aria-pressed={scope === "session"} disabled={saving} onClick={() => setScope("session")}>This session</button>
      <button type="button" aria-pressed={scope === "workspace"} disabled={saving} onClick={() => setScope("workspace")}>This workspace</button>
    </div>
    <div className="limits-sections">
      {modes.map(item => <label key={item.id} className="approval-choice">
        <input type="radio" name="approval-mode" checked={choice === item.id} disabled={saving} onChange={() => setChoice(item.id)} />
        <span><strong>{item.label}</strong><br />{item.detail}</span>
      </label>)}
    </div>
    <div className="decision-actions">
      <button type="button" className="subtle" disabled={saving} onClick={onClose}>Cancel</button>
      <button type="button" className="approve" disabled={saving} onClick={() => onSave(scope, choice)}>Save {scope === "session" ? "for this session" : "for this workspace"}</button>
    </div>
    {records.length > 0 && <div className="limits-sections">
      <h3>Auto-approved</h3>
      {records.slice(-8).reverse().map(record => <p key={record.id}>
        {record.paths.join(", ") || record.name} · {record.undoable ? <button type="button" className="subtle" disabled={saving} onClick={() => onUndo(record.id)}>Undo</button> : "Not undoable"}
      </p>)}
    </div>}
  </dialog>;
}
