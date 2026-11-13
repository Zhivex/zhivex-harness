import { setupError } from './setup-errors';
export type Run = { runId: string; status: string; prompt?: string; output: string; revision: number; review?: Review };
export type Review = { runId: string; digest: string; revision: number; canDecide: boolean; approvals: { approvalId: string; action: unknown; expiresAt: number }[]; details: unknown };
export type Snapshot = { demo?: boolean; now: number; timeZone: string; diagnostics: { ownerId: string; modules?: { id: string; version: string }[]; telegram?: { linked: boolean }; profile?: { id: string }; provider?: { model: string; apiMode: string } }; sessions: { sessionId: string; title?: string; runs: Run[] }[]; automation: null | { schedule: null | { enabled: number; next_at: number }; preferences: { key: string; value: string }[]; occurrences: { day: string; status: string }[] } };
export type Agenda = { connected: boolean; events: { id: string; summary: string; busy?: boolean; status?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }[]; timeZone: string };
const params = new URLSearchParams(location.hash.slice(1));
const provided = params.get('token');
if (provided) { sessionStorage.setItem('assistant-token', provided); history.replaceState(null, '', location.pathname + location.search); }
export const isDemo = new URLSearchParams(location.search).get('demo') === '1';
export async function api<T>(path: string, body?: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
  if (isDemo) { const { demoApi } = await import('./demo'); return demoApi(path, body) as T; }
  let response: Response;
  try { response = await fetch('/api/' + path, { signal: options.signal, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${sessionStorage.getItem('assistant-token') ?? ''}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch (error) { if (options.signal?.aborted) throw error; throw new Error('No pudimos conectar con el servicio local. Abrí Zhivex Assistant y volvé a intentar.'); }
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Esta página no está conectada al servicio de Assistant. Abrí Zhivex Assistant; la vista de desarrollo solo funciona con ?demo=1.');
  let data: any;
  try { data = await response.json(); } catch { throw new Error('El servicio devolvió una respuesta incompleta. Volvé a intentar.'); }
  if (!response.ok) {
    if (path.startsWith('setup/')) { throw new Error(setupError(data.error)); }
    throw new Error(response.status === 401 ? 'El acceso venció. Abrí de nuevo Zhivex Assistant para recuperar el acceso.' : data.error === 'REVIEW_CHANGED' ? 'La acción cambió o venció. Actualizá la revisión antes de decidir.' : data.error === 'SETUP_REQUIRED' ? 'Completá la configuración de Assistant para empezar.' : `No se pudo completar la solicitud (${data.error}).`);
  }
  return data;
}
