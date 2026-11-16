export type CalendarFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export class CalendarHttpError extends Error { constructor(readonly status: number) { super(`CALENDAR_HTTP_${status}`); } }
export async function googleJson(fetcher: CalendarFetch, url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok) throw new CalendarHttpError(response.status);
    if (!response.body) throw new Error();
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error(); } parts.push(part.value); } } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) { if (error instanceof CalendarHttpError) throw error; throw new Error('CALENDAR_TRANSPORT_UNCERTAIN'); }
}
