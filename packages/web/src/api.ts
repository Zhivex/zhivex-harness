import type { WebContext } from "./contracts.js";
import { modelSelectionRejection } from "./request-failure.js";
const storageKey = "zhivex-web-csrf";
let csrf = sessionStorage.getItem(storageKey) ?? "";
export async function request<T>(route: string, value: unknown): Promise<T> {
  const response = await fetch(`/api/${route}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-zhivex-web": "1",
      "x-zhivex-csrf": csrf,
    },
    body: JSON.stringify(value),
  }).catch(() => {
    throw new Error("WEB_REQUEST_FAILED");
  });
  const document = await response.json().catch(() => {
    throw new Error("WEB_REQUEST_FAILED");
  });
  if (!response.ok || document?.ok === false)
    throw modelSelectionRejection(route, value, response.status, document) ??
      new Error(document?.error?.code ?? "WEB_REQUEST_FAILED");
  return document as T;
}
// Remove capability before rendering or loading any optional resource; never persist it.
const pairing = new URLSearchParams(location.hash.slice(1)).get("connect");
history.replaceState(null, "", location.pathname);
const initial = request<WebContext>(
  pairing ? "connect" : "context",
  pairing ? { token: pairing } : {},
).then((context) => {
  csrf = context.csrf;
  sessionStorage.setItem(storageKey, csrf);
  return context;
});
export const context = () => initial;
export async function reconnect() {
  const result = await request<WebContext>("context", {});
  csrf = result.csrf;
  return result;
}
export const action = <T>(
  workspaceKey: string,
  action: string,
  args: Record<string, unknown> = {},
) => request<T>("action", { workspaceKey, action, ...args });
