import type { WebModelChoice, WebModelSelection } from "./contracts.js";
import type { WebRuntime } from "./runtime.js";

const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
const reads = new Set(["project.get", "policy.get", "session.list", "session.get", "run.get"]);

/** Host-only configuration change; one exclusive service owner per workspace. */
export function manageWebRuntime(
  initial: WebRuntime,
  choices: () => Promise<WebModelChoice[]>,
  prepare: (selection: WebModelSelection) => Promise<{
    attach(): Promise<WebRuntime>;
    dispose(): Promise<void>;
  }>,
): WebRuntime {
  let current = initial, changing = false, unavailable = false, mutations = 0, closing = false;
  let changeDone: Promise<void> | undefined, finishChange: (() => void) | undefined;
  const ready = () => {
    if (changing) throw new Error("WEB_MODEL_CHANGE_IN_PROGRESS");
    if (unavailable || closing) throw new Error("WEB_MODEL_UNAVAILABLE");
  };
  return {
    get workspace() { return current.workspace; },
    async modelChoices() { ready(); return choices(); },
    async selectModel(selection) {
      ready();
      if (mutations) throw new Error("WEB_MODEL_CHANGE_BUSY");
      changing = true;
      changeDone = new Promise(resolve => { finishChange = resolve; });
      try {
        const allowed = (await choices()).find(c => c.configured &&
          c.provider === selection.provider && c.model === selection.model);
        if (!allowed) throw new Error("WEB_MODEL_NOT_CONFIGURED");
        const sessions = await current.command({ method: "session.list" });
        if (!sessions.ok || sessions.data.kind !== "sessions") throw new Error("WEB_MODEL_UNAVAILABLE");
        if (sessions.data.sessions.some(s => s.runs.some(r => !terminal.has(r.status))))
          throw new Error("WEB_MODEL_CHANGE_BUSY");
        if (current.workspace.provider === selection.provider && current.workspace.model === selection.model) return;
        const previous = {provider: current.workspace.provider, model: current.workspace.model};
        // Validate credentials/configuration before retiring the existing service.
        const next = await prepare(selection);
        if (closing) { await next.dispose(); throw new Error("WEB_MODEL_UNAVAILABLE"); }
        try { await current.close(); }
        catch { await next.dispose(); unavailable = true; throw new Error("WEB_MODEL_UNAVAILABLE"); }
        try {
          const attached = await next.attach();
          if (attached.workspace.key !== initial.workspace.key || attached.workspace.provider !== selection.provider || attached.workspace.model !== selection.model) {
            await attached.close(); throw new Error("WEB_MODEL_SWITCH_FAILED");
          }
          current = attached;
        }
        catch {
          await next.dispose();
          try {
            const rollback = await prepare(previous);
            try { current = await rollback.attach(); }
            catch (error) { await rollback.dispose(); throw error; }
          }
          catch { unavailable = true; }
          throw new Error("WEB_MODEL_SWITCH_FAILED");
        }
      } finally { changing = false; finishChange?.(); changeDone = undefined; }
    },
    async command(value) {
      ready();
      const mutation = !reads.has(String(value.method));
      if (mutation) mutations++;
      try { return await current.command(value); }
      finally { if (mutation) mutations--; }
    },
    async events(...args) { ready(); return current.events(...args); },
    async review(...args) { ready(); return current.review(...args); },
    async decide(...args) {
      ready(); mutations++;
      try { return await current.decide(...args); } finally { mutations--; }
    },
    forgetIdentity(identity) { current.forgetIdentity(identity); },
    async close() { closing = true; await changeDone; await current.close(); },
  };
}
