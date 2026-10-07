import type { ZhivexHarness } from "@zhivex-ai/harness/engine";
import type { WebRuntime } from "./runtime.js";
import { hostConfigDigest } from "./host-config-digest.js";

const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
type Configured = { harness: ZhivexHarness; secrets: readonly string[] };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

/** Inspect under the existing exclusive owner before changing launch defaults.
 * No saved run, approval or host identity is rewritten. Unknown state stays bounded. */
export async function startInteractiveWebRuntime(
  create: (interactive: boolean) => Promise<Configured>,
  attach: (configured: Configured) => Promise<WebRuntime>,
) {
  const original = await create(false);
  let runtime: WebRuntime;
  try { runtime = await attach(original); }
  catch (error) { await original.harness.close(); throw error; }
  let safe = false;
  let candidate: Configured | undefined;
  try {
    const response = await runtime.command({ method: "session.list" });
    if (response.ok && response.data.kind === "sessions" && original.harness.store.list) {
      // The browser list is capped at 50 and excludes archived sessions. Inspect
      // the complete scoped store, including headless/archived unfinished runs.
      const pending: Array<{ runId: string }> = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await original.harness.store.list({ limit: 100, ...(cursor ? { cursor } : {}) }, original.harness.config.scope);
        pending.push(...page.items.filter(run => !terminal.has(run.status)));
        cursor = page.nextCursor;
        if (cursor) { if (cursors.has(cursor) || cursors.size >= 10000) throw Error("WEB_PREFLIGHT_INCOMPLETE"); cursors.add(cursor); }
      } while (cursor);
      safe = pending.length === 0;
      if (!safe) {
        // Recognize a restart of this version's exact known configuration. Never
        // construct a host from persisted user metadata or relax admission hashes.
        candidate = await create(true);
        safe = true;
        for (const run of pending) {
          const state = await original.harness.store.load(run.runId, original.harness.config.scope);
          const saved = state?.metadata?.zhivexHarnessResume;
          const metadataMatches = saved && typeof saved === "object" && !Array.isArray(saved) && saved.schemaVersion === 1 &&
            saved.config && canonical(saved.config) === canonical(candidate.harness.config);
          if (metadataMatches) continue;
          const session = response.data.sessions.find(session => session.runs.some(ref => ref.runId === run.runId));
          const snapshot = session ? await runtime.runLimits(session.sessionId, run.runId) : null;
          if (snapshot?.hostConfigDigest !== hostConfigDigest(candidate.harness.config)) { safe = false; break; }
        }
      }
    }
  } catch { safe = false; /* A failed or incomplete inspection never changes host policy. */ }
  if (!safe) {
    await candidate?.harness.close();
    const current = runtime;
    runtime = { ...current, limits: async () => ({ ...await current.limits(), legacyPending: true }) };
    return { runtime, interactive: false, legacyPending: true };
  }
  try { await runtime.close(); }
  catch (error) { await candidate?.harness.close(); throw error; }
  const next = candidate ?? await create(true);
  try { return { runtime: await attach(next), interactive: true, legacyPending: false }; }
  catch (error) { await next.harness.close(); throw error; }
}
