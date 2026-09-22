import "./credential-settings.css";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { DesktopProvider } from "./bridge.js";
import type { CredentialProbe } from "./credential-store.js";
const messages: Record<CredentialProbe, string> = {
  present: "Key saved in Keychain.",
  missing: "No saved key.",
  saved: "Key saved. The project now uses the new credential.",
  deleted: "Key deleted from Keychain.",
  cancelled: "Configuration cancelled; the previous key is preserved.",
  locked: "Unlock the keychain in Keychain Access and try again.",
  unavailable:
    "Keychain access was not confirmed. Check the status before trying again.",
  invalid: "Invalid key: use a value without spaces or line breaks.",
  unsupported: "Secure storage is only available on macOS.",
  connected: "Connection authorized to query models; no generation was run.",
  "invalid-credential": "The provider rejected the key. Configure a new one.",
  forbidden: "The key does not have permission to query models.",
  "rate-limited": "The provider rate-limited the request. Try again later.",
  "network-error":
    "Could not verify the connection. Check your network and try again.",
};
export function CredentialSettings({
  providers,
  initialProvider = "openai",
  changed,
  open = false,
  onOpenChange = () => {},
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  providers: DesktopProvider[];
  initialProvider?: string;
  changed: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const lock = useRef(false);
  const modal = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !modal.current?.open) modal.current?.showModal();
    else if (!open && modal.current?.open) modal.current.close();
  }, [open]);
  const act = async (operation: () => Promise<CredentialProbe>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await operation();
      if (["saved", "deleted", "unavailable"].includes(result)) await changed();
      setMessage(messages[result]);
    } catch {
      setMessage(
        "Work is active or its completion was not confirmed. Wait for it to finish before changing credentials; if the error persists, restart the application.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="credential-settings">
      <button
        type="button"
        data-action="open-credentials"
        onClick={() => onOpenChange(true)}
      >
        Credentials
      </button>
      {createPortal(
        <dialog
          ref={modal}
          className="credential-dialog"
          aria-labelledby="credential-title"
          onCancel={() => onOpenChange(false)}
          onClose={() => onOpenChange(false)}
        >
          <div className="dialog-header">
            <h2 id="credential-title">Credentials</h2>
            <button
              type="button"
              aria-label="Close credentials"
              onClick={() => onOpenChange(false)}
            >
              Close
            </button>
          </div>
          <label>
            Provider
            <select
              aria-label="Credential provider"
              value={provider}
              disabled={busy}
              onChange={(e) => {
                setProvider(e.target.value);
                setMessage("");
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            Enter the key in a secure macOS dialog to save it in Keychain.
            Finish active tasks before replacing or deleting it.
          </p>
          <button
            disabled={busy}
            className="secondary"
            data-action="credential-status"
            onClick={() =>
              void act(() => window.harness.credentialStatus(provider))
            }
          >
            Check key status
          </button>
          <button
            disabled={busy}
            data-action="credential-configure"
            onClick={() =>
              void act(() => window.harness.configureCredential(provider))
            }
          >
            Save or replace key
          </button>
          <button
            disabled={busy}
            className="secondary"
            data-action="credential-probe"
            onClick={() =>
              void act(() => window.harness.probeCredential(provider))
            }
          >
            Test connection
          </button>
          <button
            disabled={busy}
            className="secondary"
            data-action="credential-delete"
            onClick={() =>
              void act(() => window.harness.deleteCredential(provider))
            }
          >
            Delete key from Keychain
          </button>
          {message ? <p role="status">{message}</p> : null}
        </dialog>,
        document.body,
      )}
    </div>
  );
}
