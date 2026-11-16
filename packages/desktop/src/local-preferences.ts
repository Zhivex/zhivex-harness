const prefix = "harness.ui.v1:";
const memory = new Map<string, string>();
const keyFor = (kind: string, project: string, session: string) =>
  prefix + JSON.stringify([kind, project, session]);

export function readPreference(
  kind: string,
  project: string,
  session: string,
): string {
  const key = keyFor(kind, project, session);
  if (memory.has(key)) return memory.get(key)!;
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Keep a memory fallback if the disk is full or local storage is unavailable. */
export function writePreference(
  kind: string,
  project: string,
  session: string,
  value: string,
): boolean {
  const key = keyFor(kind, project, session);
  memory.set(key, value);
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function eventPollDelay(
  emptyPages: number,
  failures: number,
  hidden: boolean,
): number {
  if (failures) return Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
  if (hidden) return 5000;
  return Math.min(2000, 100 * 2 ** Math.min(emptyPages, 5));
}
