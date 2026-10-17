import type { WebModelChoice } from "./contracts.js";
import { choiceKey } from "./model-choice.js";

export const MODEL_PICKER_KEY = "zhivex.code.modelPicker.v1";

export interface ModelPickerMemory {
  favorites: string[];
  recents: string[];
}

export function readModelPickerMemory(raw: string | null): ModelPickerMemory {
  if (!raw) return { favorites: [], recents: [] };
  try {
    const value = JSON.parse(raw) as Partial<ModelPickerMemory>;
    const list = (items: unknown) => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").slice(0, 40) : [];
    return { favorites: list(value.favorites), recents: list(value.recents).slice(0, 3) };
  } catch {
    return { favorites: [], recents: [] };
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

export interface ModelRow {
  id: string;
  choice: WebModelChoice;
  group: string;
  favorite: boolean;
  disabled: boolean;
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

export function modelRows(choices: WebModelChoice[], memory: ModelPickerMemory, query: string): ModelRow[] {
  const visible = choices.filter(choice => matches(choice, query));
  const byKey = new Map(visible.map(choice => [choiceKey(choice), choice]));
  const rows: ModelRow[] = [];
  const push = (group: string, choice: WebModelChoice) => {
    rows.push({
      id: `${group}:${choiceKey(choice)}`,
      choice,
      group,
      favorite: memory.favorites.includes(choiceKey(choice)),
      disabled: !choice.configured,
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
  for (const providerName of providers) {
    const items = visible.filter(choice => choice.providerName === providerName).sort(byCatalog);
    for (const choice of items) push(providerName, choice);
  }
  return rows;
}

export function providerCredentialNote(choices: WebModelChoice[], providerName: string) {
  const items = choices.filter(choice => choice.providerName === providerName);
  return items.length > 0 && items.every(choice => !choice.configured);
}
