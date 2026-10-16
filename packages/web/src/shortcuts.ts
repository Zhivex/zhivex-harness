const TEXT_FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTextField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return TEXT_FIELDS.has(target.tagName) || target.isContentEditable;
}

/** Alt+Shift shortcuts use event.code so macOS Option does not rewrite the key. */
export function altShiftAction(event: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string }) {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
  const actions: Record<string, string> = {
    KeyA: "approve",
    KeyR: "reject",
    KeyP: "position",
    KeyH: "minimize",
    KeyM: "model",
    KeyS: "favorite",
    KeyJ: "drawer",
    KeyN: "session",
  };
  return actions[event.code];
}
