export type Run = { runId: string; status: string; output: string; revision: number; review?: Review };
export type Review = { runId: string; digest: string; revision: number; canDecide: boolean; approvals: { approvalId: string; action: unknown; expiresAt: number }[]; details: unknown };
export type Snapshot = { demo?: boolean; now: number; timeZone: string; diagnostics: { ownerId: string; modules?: { id: string; version: string }[]; telegram?: { linked: boolean }; profile?: { id: string }; provider?: { model: string; apiMode: string } }; sessions: { sessionId: string; title?: string; runs: Run[] }[]; automation: null | { schedule: null | { enabled: number; next_at: number }; preferences: { key: string; value: string }[]; occurrences: { day: string; status: string }[] } };
export type Agenda = { connected: boolean; events: { id: string; summary: string; busy?: boolean; status?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }[]; timeZone: string };
const params = new URLSearchParams(location.hash.slice(1));
const provided = params.get('token');
if (provided) { sessionStorage.setItem('assistant-token', provided); history.replaceState(null, '', location.pathname + location.search); }
export const isDemo = new URLSearchParams(location.search).get('demo') === '1';
export async function api<T>(path: string, body?: unknown): Promise<T> {
  if (isDemo) { const { demoApi } = await import('./demo'); return demoApi(path, body) as T; }
  const response = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${sessionStorage.getItem('assistant-token') ?? ''}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(response.status === 401 ? 'Abrí el enlace privado que imprime Assistant al iniciar con --web.' : data.error === 'REVIEW_CHANGED' ? 'La acción cambió o venció. Actualizá la revisión antes de decidir.' : `No se pudo completar la solicitud (${data.error}).`); return data;
}
