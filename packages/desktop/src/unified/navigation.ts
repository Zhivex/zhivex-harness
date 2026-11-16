import {readPreference, writePreference} from '../local-preferences.js';
export const navigationPages = ['conversation', 'review', 'history', 'worktrees', 'checkpoints', 'execution', 'context', 'git', 'personal', 'automations', 'today', 'agenda', 'notes', 'proactive', 'drafts'] as const;
export type NavigationPage = typeof navigationPages[number];
export interface NavigationState {page: NavigationPage; sessionId: string}
const shared = new Set<NavigationPage>(['conversation', 'review', 'history']);
export function readNavigation(projectId: string, area: 'assistant' | 'code'): NavigationState {
  const fallback: NavigationState = {page: 'conversation', sessionId: ''};
  try {
    const value = JSON.parse(readPreference('navigation', projectId, area));
    if (!value || value.version !== 1 || typeof value.sessionId !== 'string' || value.sessionId.length > 200) return fallback;
    const page = navigationPages.includes(value.page) && (shared.has(value.page) || (area === 'code' ? ['worktrees', 'checkpoints', 'execution', 'context', 'git'] : ['personal', 'automations', 'today', 'agenda', 'notes', 'proactive', 'drafts']).includes(value.page)) ? value.page : fallback.page;
    return {page, sessionId: value.sessionId};
  } catch {return fallback;}
}
export function writeNavigation(projectId: string, area: 'assistant' | 'code', value: NavigationState) {
  return writePreference('navigation', projectId, area, JSON.stringify({version: 1, ...value}));
}
