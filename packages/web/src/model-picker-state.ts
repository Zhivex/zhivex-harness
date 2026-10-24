import type { WebModelChoice } from "./contracts.js";
import { choiceKey } from "./model-choice.js";

export const MODEL_PICKER_KEY = "zhivex.code.modelPicker.v1";

export interface ModelPickerMemory {
  favorites: string[];
  recents: string[];
  /** Absent or true keeps unconfigured providers collapsed. */
  configuredOnly: boolean;
  lastUsedByWorkspace: Record<string, string>;
}

export function readModelPickerMemory(raw: string | null): ModelPickerMemory {
  if (!raw) return { favorites: [], recents: [], configuredOnly: true, lastUsedByWorkspace: {} };
  try {
    const value = JSON.parse(raw) as Partial<ModelPickerMemory>;
    const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").slice(0, 40) : [];
    const lastUsedByWorkspace: Record<string, string> = {};
    if (value.lastUsedByWorkspace && typeof value.lastUsedByWorkspace === "object") {
      for (const [workspace, model] of Object.entries(value.lastUsedByWorkspace)) {
        if (typeof model === "string") lastUsedByWorkspace[workspace] = model;
      }
    }
    return {
      favorites: list(value.favorites),
      recents: list(value.recents).slice(0, 3),
      configuredOnly: value.configuredOnly !== false,
      lastUsedByWorkspace,
    };
  } catch {
    return { favorites: [], recents: [], configuredOnly: true, lastUsedByWorkspace: {} };
  }
}

export function toggleFavorite(memory: ModelPickerMemory, key: string): ModelPickerMemory {
  const favorites = memory.favorites.includes(key)
    ? memory.favorites.filter(item => item !== key)
    : [...memory.favorites, key];
  return { ...memory, favorites };
}

export function rememberModel(memory: ModelPickerMemory, key: string): ModelPickerMemory {
  return { ...memory, recents: [key, ...memory.recents.filter(item => item !== key)].slice(0, 3) };
}

export function rememberWorkspaceModel(memory: ModelPickerMemory, workspaceKey: string, modelKey: string): ModelPickerMemory {
  if (!workspaceKey) return rememberModel(memory, modelKey);
  return {
    ...rememberModel(memory, modelKey),
    lastUsedByWorkspace: { ...memory.lastUsedByWorkspace, [workspaceKey]: modelKey },
  };
}

export function setConfiguredOnly(memory: ModelPickerMemory, configuredOnly: boolean): ModelPickerMemory {
  return { ...memory, configuredOnly };
}

export interface ModelRow {
  id: string;
  choice: WebModelChoice;
  group: string;
  favorite: boolean;
  disabled: boolean;
  /** Configured providers stay in the main list. Unconfigured providers share one bottom section. */
  section: "ready" | "needs-credentials";
}

export interface ModelRowOptions {
  /** Hide unconfigured providers. Search still returns their matches. */
  configuredOnly?: boolean;
  /** Last-used model key for the open workspace. Sorted first inside its provider. */
  preferredKey?: string;
}

function matches(choice: WebModelChoice, query: string) {
  if (!query) return true;
  const haystack = `${choice.name} ${choice.model} ${choice.providerName} ${choice.provider}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function byCatalog(preferredKey: string | undefined) {
  return (a: WebModelChoice, b: WebModelChoice) => {
    const preferred = (choice: WebModelChoice) => choiceKey(choice) === preferredKey ? 0 : 1;
    const group = (choice: WebModelChoice) => choice.group === "primary" ? 0 : 1;
    return preferred(a) - preferred(b) || group(a) - group(b) || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
  };
}

export function modelRows(choices: WebModelChoice[], memory: ModelPickerMemory, query: string, options: ModelRowOptions = {}): ModelRow[] {
  const trimmed = query.trim();
  const configuredOnly = options.configuredOnly ?? false;
  const visible = choices.filter(choice => matches(choice, trimmed) && (!configuredOnly || trimmed.length > 0 || choice.configured));
  const byKey = new Map(visible.map(choice => [choiceKey(choice), choice]));
  const rows: ModelRow[] = [];
  const push = (group: string, choice: WebModelChoice, section: ModelRow["section"]) => {
    rows.push({
      id: `${section}:${group}:${choiceKey(choice)}`,
      choice,
      group,
      favorite: memory.favorites.includes(choiceKey(choice)),
      disabled: !choice.configured,
      section,
    });
  };
  const ready = (choice: WebModelChoice) => !configuredOnly || trimmed.length > 0 || choice.configured;
  for (const key of memory.favorites) {
    const choice = byKey.get(key);
    if (choice && choice.configured && ready(choice)) push("Favorites", choice, "ready");
  }
  for (const key of memory.recents) {
    const choice = byKey.get(key);
    if (choice && choice.configured && !memory.favorites.includes(key) && ready(choice)) push("Recent", choice, "ready");
  }
  const providerNames: string[] = [];
  for (const choice of visible) {
    if (!providerNames.includes(choice.providerName)) providerNames.push(choice.providerName);
  }
  const configuredNames = providerNames.filter(name => visible.some(choice => choice.providerName === name && choice.configured));
  const sort = byCatalog(options.preferredKey);
  for (const providerName of configuredNames) {
    const items = visible.filter(choice => choice.providerName === providerName && choice.configured).sort(sort);
    for (const choice of items) push(providerName, choice, "ready");
  }
  const unconfigured = visible.filter(choice => !choice.configured).sort(sort);
  if (!configuredOnly || trimmed.length > 0) {
    for (const choice of unconfigured) push("Not configured", choice, "needs-credentials");
  }
  return rows;
}

export function providerCredentialNote(choices: WebModelChoice[], providerName: string) {
  const items = choices.filter(choice => choice.providerName === providerName);
  return items.length > 0 && items.every(choice => !choice.configured);
}

export function unconfiguredProviderNames(choices: WebModelChoice[]) {
  const names: string[] = [];
  for (const choice of choices) {
    if (choice.configured || names.includes(choice.providerName)) continue;
    if (choices.some(item => item.providerName === choice.providerName && item.configured)) continue;
    names.push(choice.providerName);
  }
  return names;
}

/** Listbox type-ahead. `query` is the typed prefix; search filtering is separate. */
export function nextTypeaheadIndex(labels: readonly string[], query: string, from: number) {
  const needle = query.trim().toLowerCase();
  if (!needle || labels.length === 0) return Math.max(0, from);
  for (let step = 1; step <= labels.length; step += 1) {
    const index = (from + step + labels.length) % labels.length;
    if (labels[index]?.toLowerCase().startsWith(needle)) return index;
  }
  return from;
}
