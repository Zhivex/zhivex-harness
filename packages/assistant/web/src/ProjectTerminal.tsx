import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Terminal as Xterm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
type Session = { id: string; projectKey: string; status: string; exitCode?: number };
type Page = { start: number; end: number; data: number[]; truncated: boolean; exitCode?: number };
export function ProjectTerminal({ projectKey }: { projectKey: string }) {
  const [sessions, setSessions] = useState<Session[]>([]), [id, setId] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const element = useRef<HTMLDivElement>(null), terminal = useRef<Xterm | null>(null), mounted = useRef(true);
  const act = (body: unknown, signal?: AbortSignal) => api<unknown>('terminal', body, { signal });
  const load = async (signal?: AbortSignal) => { const result = await act({ action: 'list', projectKey }, signal) as { sessions: Session[] }; if (signal?.aborted || !mounted.current) return; setSessions(result.sessions); setId(previous => result.sessions.some(s => s.id === previous) ? previous : result.sessions[0]?.id ?? ''); };
  useEffect(() => { mounted.current = true; const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }); return () => { mounted.current = false; controller.abort(); }; }, [projectKey]);
  useEffect(() => {
    if (!id || !element.current) return;
    const controller = new AbortController(); let cursor = 0, disposed = false, observer: ResizeObserver | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let term: Xterm | undefined, queued = 0, inputFailed = false, writes = Promise.resolve();
    setError(''); setStatus('Conectando terminal…');
    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
        if (disposed || !element.current) return;
        // Scope nonce injection to xterm's supported document override; no global DOM patch
        // and no unsafe-inline styles or scripts in the application's CSP.
        const nonce = document.querySelector<HTMLMetaElement>('meta[name="terminal-style-nonce"]')?.content ?? '';
        const terminalDocument = new Proxy(document, { get(target, key) {
          if (key === 'createElement') return (tag: string, options?: ElementCreationOptions) => { const element = target.createElement(tag, options); if (tag === 'style') element.setAttribute('nonce', nonce); return element; };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } });
        term = new Terminal({ documentOverride: terminalDocument, cols: 80, rows: 20, scrollback: 2000, fontSize: 13, screenReaderMode: true, theme: { background: '#172328', foreground: '#e3eeed' }, linkHandler: { activate() {} } });
        const fit = new FitAddon(); term.loadAddon(fit); term.open(element.current); terminal.current = term;
        term.parser.registerOscHandler(52, () => true); // Terminal output cannot read/write the system clipboard.
        term.onData(data => {
          if (inputFailed || disposed) return;
          if (data.length > 8192 || queued + data.length > 32768) { setError('Entrada demasiado grande. Pegá bloques de hasta 8.192 caracteres.'); return; }
          queued += data.length;
          writes = writes.then(async () => { if (!disposed && !inputFailed) await act({ action: 'write', id, data }, controller.signal); }).catch(() => { inputFailed = true; if (!disposed) setError('No se confirmó la entrada. Inspeccioná la terminal antes de volver a escribir; no se reenviaron teclas.'); }).finally(() => { queued -= data.length; });
        });
        const resize = () => { if (disposed || !term || !element.current?.clientWidth) return; fit.fit(); const cols = Math.min(400, Math.max(20, term.cols)), rows = Math.min(200, Math.max(5, term.rows)); if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows); void act({ action: 'resize', id, cols, rows }, controller.signal).catch(e => { if (!disposed) setError(e.message); }); };
        observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 120); }); observer.observe(element.current); resize(); term.focus();
        while (!disposed) {
          const page = await act({ action: 'read', id, after: cursor }, controller.signal) as Page;
          if (disposed) break;
          if (page.truncated) { term.reset(); term.writeln('[Salida anterior recortada por el límite del buffer]'); }
          if (page.start !== cursor && !page.truncated) throw new Error('TERMINAL_CURSOR_CHANGED');
          if (page.data.length) await new Promise<void>(resolve => term!.write(new Uint8Array(page.data), resolve));
          cursor = page.end; setStatus(page.exitCode === undefined ? 'Terminal local activa' : `Terminal finalizada · salida ${page.exitCode}`);
          if (page.exitCode !== undefined && !page.data.length) { inputFailed = true; break; }
          if (page.data.length < 16384) await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 180); controller.signal.addEventListener('abort', done, { once: true }); });
        }
      } catch (e) { if (!disposed) setError((e as Error).message); }
    })();
    return () => { disposed = true; controller.abort(); observer?.disconnect(); clearTimeout(resizeTimer); term?.dispose(); terminal.current = null; };
  }, [id]);
  return <section className="project-terminal" aria-label="Terminal interactiva"><p>Terminal local operada por vos. Sus comandos no autorizan herramientas del agente. Al cerrar la ventana sigue activa; al salir de la app se terminan sus procesos.</p>
    {error ? <p role="alert">{error}</p> : null}<div className="terminal-controls"><button disabled={busy || sessions.length >= 8} onClick={() => { setBusy(true); setError(''); void act({ action: 'open', projectKey, cols: 80, rows: 20 }).then(async result => { if (!mounted.current) return; await load(); setId((result as Session).id); }).catch(e => { if (mounted.current) setError(e.message); }).finally(() => { if (mounted.current) setBusy(false); }); }}>Abrir terminal local</button>
    <label>Sesión terminal<select value={id} onChange={e => setId(e.target.value)}><option value="">Elegí una terminal</option>{sessions.map((session, i) => <option key={session.id} value={session.id}>Terminal {i + 1} · {session.status}</option>)}</select></label>
    <button disabled={!id || busy} onClick={() => terminal.current?.input('\x03', true)}>Interrumpir (Ctrl+C)</button><button disabled={!id || busy} onClick={() => { setBusy(true); void act({ action: 'close', id }).then(() => load()).catch(e => { if (mounted.current) setError(e.message); }).finally(() => { if (mounted.current) setBusy(false); }); }}>Cerrar terminal y procesos</button></div>
    <p role="status">{status || 'Las terminales no se reabren automáticamente después de reiniciar la app.'}</p><div className="terminal-screen" ref={element}/>
  </section>;
}
