import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/** Private parent pipe only. No renderer can provide a selected filesystem path. */
export function nativeProjectSelection(input: Readable, output: Writable, onStop: () => void, onQuit: () => void = () => {}) {
  input.setEncoding('utf8');
  let buffer = '', stopped = false;
  const requests = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let pending: { id: string; resolve(value: string | null): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('NATIVE_SELECTION_STOPPED')); pending = undefined; }
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('NATIVE_STOPPED')); } requests.clear();
    onStop();
  };
  input.on('data', chunk => {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer) > 1048576) { stop(); return; }
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line === 'stop') { stop(); return; }
      try {
        const message = JSON.parse(line);
        if (message.kind === 'quit-request') { onQuit(); continue; }
        if (message.kind === 'native-result') { const request = requests.get(message.requestId); if (request) { requests.delete(message.requestId); clearTimeout(request.timer); if (message.ok) request.resolve(message.data); else request.reject(new Error('NATIVE_ACTION_FAILED')); } continue; }
        if (!pending || message.kind !== 'project-selected' || message.requestId !== pending.id) continue;
        const request = pending; pending = undefined; clearTimeout(request.timer);
        if (message.path === null) request.resolve(null);
        else if (typeof message.path === 'string' && message.path.length <= 4096 && !message.path.includes('\0')) request.resolve(message.path);
        else request.reject(new Error('NATIVE_SELECTION_FAILED'));
      } catch { stop(); return; }
    }
  });
  input.once('end', stop);
  return {
    request: (method: string, input: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
      if (stopped || requests.size >= 64) { reject(new Error('NATIVE_BUSY')); return; }
      const requestId = randomUUID(); const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('NATIVE_TIMEOUT')); }, method === 'notification-permission' ? 120000 : 10000);
      requests.set(requestId, { resolve, reject, timer }); output.write(JSON.stringify({ kind: 'native-request', requestId, method, input }) + '\n');
    }),
    choose: () => new Promise<string | null>((resolve, reject) => {
      if (stopped || pending) { reject(new Error('NATIVE_SELECTION_BUSY')); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { pending = undefined; reject(new Error('NATIVE_SELECTION_TIMEOUT')); }, 120000);
      pending = { id, resolve, reject, timer };
      output.write(JSON.stringify({ kind: 'choose-project', requestId: id }) + '\n');
    }),
  };
}
