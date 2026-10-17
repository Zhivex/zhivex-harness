import type { WebModelChoice } from "./contracts.js";
import { choiceKey } from "./model-choice.js";

export const MODEL_PICKER_KEY = "zhivex.code.modelPicker.v1";

export interface ModelPickerMemory {
  favorites: string[];
  recents: string[];
  lastUsedByWorkspace?: Record<string, string>;
}

export interface ModelRowOptions {
  configuredOnly?: boolean;
  workspaceKey?: string;
}

export function readModelPickerMemory(raw: string | null): ModelPickerMemory {
  if (!raw) return { favorites: [], recents: [], lastUsedByWorkspace: {} };
  try {
    const value = JSON.parse(raw) as Partial<ModelPickerMemory>;
    const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").slice(0, 40) : [];
    const lastUsedByWorkspace: Record<string, string> = {};
    if (value.lastUsedByWorkspace && typeof value.lastUsedByWorkspace === "object") {
      for (const [workspace, key] of Object.entries(value.lastUsedByWorkspace).slice(-40)) {
        if (typeof key === "string") lastUsedByWorkspace[workspace] = key;
      }
    }
    return { favorites: list(value.favorites), recents: list(value.recents).slice(0, 3), lastUsedByWorkspace };
  } catch {
    return { favorites: [], recents: [], lastUsedByWorkspace: {} };
  }
}

export function toggleFavorite(memory: ModelPickerMemory, key: string): ModelPickerMemory {
  const favorites = memory.favorites.includes(key)
    ? memory.favorites.filter(item => item !== key)
    : [...memory.favorites, key];
  return { ...memory, favorites };
}

export function rememberModel(memory: ModelPickerMemory, key: string, workspaceKey?: string): ModelPickerMemory {
  const lastUsedByWorkspace = { ...(memory.lastUsedByWorkspace ?? {}) };
  if (workspaceKey) {
    delete lastUsedByWorkspace[workspaceKey];
    lastUsedByWorkspace[workspaceKey] = key;
  }
  return {
    ...memory,
    recents: [key, ...memory.recents.filter(item => item !== key)].slice(0, 3),
    lastUsedByWorkspace: Object.fromEntries(Object.entries(lastUsedByWorkspace).slice(-40)),
  };
}

export interface ModelRow {
  id: string;
  choice: WebModelChoice;
  group: string;
  favorite: boolean;
  disabled: boolean;
  section: "configured" | "unconfigured";
}

function matches(choice: WebModelChoice, query: string) {
  if (!query) return true;
  const haystack = `${choice.name} ${choice.model} ${choice.providerName} ${choice.provider}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function byCatalog(a: WebModelChoice, b: WebModelChoice) {
  const group = (choice: WebModelChoice) => choice.group === "primary" ? 0 : 1;
  return group(a) - group(b) || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
}

export function modelRows(choices: WebModelChoice[], memory: ModelPickerMemory, query: string, options: ModelRowOptions = {}): ModelRow[] {
  const matched = choices.filter(choice => matches(choice, query));
  const visible = options.configuredOnly ? matched.filter(choice => choice.configured) : matched;
  const credentialed = new Set(choices.filter(choice => choice.configured).map(choice => choice.providerName));
  const byKey = new Map(visible.map(choice => [choiceKey(choice), choice]));
  const rows: ModelRow[] = [];
  const lastUsed = options.workspaceKey ? memory.lastUsedByWorkspace?.[options.workspaceKey] : undefined;
  const push = (group: string, choice: WebModelChoice) => {
    rows.push({
      id: `${group}:${choiceKey(choice)}`,
      choice,
      group,
      favorite: memory.favorites.includes(choiceKey(choice)),
      disabled: !choice.configured,
      section: credentialed.has(choice.providerName) ? "configured" : "unconfigured",
    });
  };
  for (const key of memory.favorites) {
    const choice = byKey.get(key);
    if (choice) push("Favorites", choice);
  }
  for (const key of memory.recents) {
    const choice = byKey.get(key);
    if (choice && !memory.favorites.includes(key)) push("Recent", choice);
  }
  const providers = [...new Set(visible.map(choice => choice.providerName))];
  providers.sort((a, b) => Number(!credentialed.has(a)) - Number(!credentialed.has(b)));
  for (const providerName of providers) {
    const items = visible.filter(choice => choice.providerName === providerName).sort((a, b) => {
      const rank = (choice: WebModelChoice) => choiceKey(choice) === lastUsed ? 0 : 1;
      return rank(a) - rank(b) || byCatalog(a, b);
    });
    for (const choice of items) push(providerName, choice);
  }
  return rows;
}

export function providerCredentialNote(choices: WebModelChoice[], providerName: string) {
  const items = choices.filter(choice => choice.providerName === providerName);
  return items.length > 0 && items.every(choice => !choice.configured);
}

export type PickerKeyFocus = "search" | "star";
export type PickerKeyAction =
  | { type: "index"; index: number }
  | { type: "apply" }
  | { type: "close" }
  | { type: "star" }
  | { type: "search" };

export function pickerKeyAction(key: string, index: number, count: number, focus: PickerKeyFocus): PickerKeyAction | null {
  if ((key === "Enter" || key === " ") && focus === "star") return null;
  if (key === "ArrowDown") return { type: "index", index: count ? (index + 1) % count : 0 };
  if (key === "ArrowUp") return { type: "index", index: count ? (index - 1 + count) % count : 0 };
  if (key === "Home") return { type: "index", index: 0 };
  if (key === "End") return { type: "index", index: Math.max(0, count - 1) };
  if (key === "Enter") return count ? { type: "apply" } : null;
  if (key === "Escape") return { type: "close" };
  if (key === "ArrowRight" && focus === "search") return { type: "star" };
  if (key === "ArrowLeft" && focus === "star") return { type: "search" };
  return null;
}
