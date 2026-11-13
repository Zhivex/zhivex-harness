import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AssistantWorkItem } from './application-contracts.js';
import type { NativeBridge } from './terminal.js';
/** Desktop shutdown policy adapted from desktop/src/shutdown.ts: pause, then drain/cancel. */
export async function createDesktopLifecycle(options: { directory: string; native: NativeBridge; control(operation: 'pause' | 'resume' | 'cancel'): Promise<boolean>; work(): Promise<AssistantWorkItem[]>; close(): Promise<void>; pollMs?: number }) {
  const file = path.join(options.directory, 'desktop-preferences.json');
  let enabled = false;
  let selection: { project: string; conversation: string } | undefined;
  const selectionSchema = z.object({project:z.string().max(256),conversation:z.string().max(256)}).strict();
  try { const saved = z.object({ notifications: z.boolean(), selection: selectionSchema.optional() }).parse(JSON.parse(await readFile(file, 'utf8'))); enabled=saved.notifications; selection=saved.selection; } catch {}
  let phase: 'running' | 'requested' | 'draining' | 'cancelling' | 'closing' = 'running', error = '', permission = 'unknown', generation = 0, stopped = false;
  let queue: AssistantWorkItem[] = [], seeded = false, polling = false;
  const seen = new Map<string, string>();
  const poll = async () => {
    if (polling || stopped || phase === 'closing') return; polling = true;
    try {
      queue = await options.work();
      let notify = false;
      for (const item of queue) { const prior = seen.get(item.id); if (seeded && prior !== item.status && item.status !== 'unavailable' && (item.attention || item.status === 'completed')) notify = true; seen.set(item.id, item.status); }
      while (seen.size > 1000) seen.delete(seen.keys().next().value!);
      seeded = true;
      if (notify && enabled) { try { await options.native.request('notification-show'); } catch { error = 'No se pudo entregar el aviso. Revisá los permisos de notificaciones del sistema.'; } }
    } catch { error = 'No se pudo reconciliar la actividad. No se reejecutó ninguna tarea.'; }
    finally { polling = false; }
  };
  const save = async () => { await mkdir(options.directory, { recursive: true, mode: 0o700 }); await writeFile(file + '.tmp', JSON.stringify({ notifications: enabled, selection }), { mode: 0o600 }); await rename(file + '.tmp', file); };
  let saving = Promise.resolve();
  const persist = () => saving = saving.catch(() => {}).then(save);
  const timer = setInterval(() => void poll(), options.pollMs ?? 2000); timer.unref();
  // Serialize admission changes so a late pause cannot undo a newer stay decision.
  let controls = Promise.resolve(false);
  const control = (operation: 'pause' | 'resume' | 'cancel') => { const next = controls.catch(() => false).then(() => options.control(operation)); controls = next; return next; };
  const resume = async () => { await control('resume'); phase = 'running'; };
  const quit = async (cancel: boolean, epoch: number) => {
    try {
      let busy = await control('pause');
      if (generation !== epoch || stopped) return;
      if (cancel && busy) await control('cancel');
      const deadline = Date.now() + 10000;
      while (busy && generation === epoch && !stopped) {
        if (cancel && Date.now() >= deadline) throw new Error('CANCELLATION_UNCONFIRMED');
        await new Promise(resolve => setTimeout(resolve, 100)); if (generation !== epoch || stopped) return; busy = await control('pause');
      }
      if (generation !== epoch || stopped) return;
      phase = 'closing'; await options.native.request('terminal-close-all');
      await options.close(); stopped = true; clearInterval(timer);
    } catch { if (generation === epoch && !stopped) { await resume().catch(() => {}); phase = 'requested'; error = 'La app sigue abierta: no se confirmó el cierre de todas las operaciones. Revisá su estado antes de salir.'; } }
  };
  return {
    state: () => ({ native: true, phase, error, selection, notifications: enabled, permission, work: queue, backgroundPolicy: 'hide-window' }),
    requestQuit() { if (phase === 'running') { phase = 'requested'; error = ''; } },
    async action(input: unknown) {
      if (typeof input === 'object' && input !== null && 'action' in input && input.action === 'select-view') { const value=z.object({action:z.literal('select-view'),selection:selectionSchema}).strict().parse(input); selection=value.selection; await persist(); return this.state(); }
      const value = z.object({ action: z.enum(['stay', 'drain', 'cancel', 'enable-notifications', 'disable-notifications', 'notification-status']) }).strict().parse(input);
      if (value.action === 'notification-status') { permission = (await options.native.request('notification-status') as { permission: string }).permission; }
      else if (value.action.endsWith('notifications')) {
        if (value.action === 'enable-notifications') { permission = (await options.native.request('notification-permission') as { permission: string }).permission; enabled = permission === 'granted'; } else enabled = false;
        await persist();
      } else if (value.action === 'stay') { generation++; await resume(); error = ''; }
      else {
        if (phase === 'closing' || phase === 'cancelling' || (phase === 'draining' && value.action !== 'cancel')) throw new Error('SHUTDOWN_BUSY');
        phase = value.action === 'drain' ? 'draining' : 'cancelling'; error = ''; void quit(value.action === 'cancel', ++generation);
      }
      return this.state();
    },
    poll,
    stop() { stopped = true; generation++; clearInterval(timer); },
  };
}
export type DesktopLifecycle = Awaited<ReturnType<typeof createDesktopLifecycle>>;
