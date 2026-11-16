/** Serializable application projections. No host, filesystem, provider or UI dependencies. */
export const APPLICATION_PROJECTION_VERSION = 1 as const;
export interface PersonalSnapshot {
  enabled: boolean;
  tasks: {id: string; title: string; due_date: string | null; status: string; created_at: number}[];
  total: number; nextOffset: number | null;
  proactive?: {
    enabled: boolean;
    sources?: {calendar: boolean; replies: string[]};
    health?: {source: string; status: string; checkedAt: number}[];
    policy: {enabled: boolean; timeZone: string; channel: 'web' | 'telegram'; calendar: boolean; tasks: boolean; replies: boolean; quietStart: string; quietEnd: string; maxPerDay: number; bufferMinutes: number} | null;
    alerts: {id: string; kind: string; text: string; status: string; channel: string; created_at: number}[];
    watches: {id: string; title: string; status: string; due_at: number}[];
  };
  reminders: {id: string; text: string; due_at: number; time_zone: string; channel: string; status: string}[];
}
export interface NotesSnapshot {
  enabled: boolean;
  notes: {id: string; title: string; created_at: number}[];
  total: number; nextOffset: number | null;
  note?: {id: string; title: string; created_at: number; body: string};
}
export interface AutomationSnapshot {
  available: boolean; linked: boolean; delivery: 'telegram'; digest: string;
  state: {
    schedule: {enabled: number; revision: number; next_at: number} | null;
    preferences: {key: string; value: string}[];
    occurrences: {id: string; day: string; status: string; attempts: number}[];
  } | null;
}
export type AutomationChange = {action: 'configure' | 'pause' | 'resume' | 'delete' | 'forget'; expectedDigest: string; confirmed: true; localTime?: string; timeZone?: string};
export interface AgendaSnapshot {
  connected: boolean; canCreate?: boolean; complete: boolean; date: string; timeZone: string; calendarId?: string;
  events: {id: string; summary: string; status?: string | undefined; busy?: boolean | undefined; start: {date?: string | undefined; dateTime?: string | undefined}; end: {date?: string | undefined; dateTime?: string | undefined}}[];
}
export interface CodeContextSnapshot {
  schemaVersion: 1; enabled: boolean; provider: string; model: string; fingerprint: string;
  manifest?: {path: string; digest: string; bytes: number};
  sources: {kind: 'context' | 'rule'; path: string; digest: string; bytes: number}[];
  skills: {id: string; path: string; digest: string; bytes: number}[];
}

export const APPLICATION_PROTOCOL_VERSION = 1 as const;
export interface ProviderSummary {kind: 'openai-compatible' | 'meta' | 'qwen'; model: string; webSearch: boolean; canEnableWebSearch: boolean}
export interface AssistantSetupState {
  managed: boolean; setupRevision: number; canStop: boolean; ready: boolean; busy: boolean; error: string | null;
  locked: boolean; configured: boolean; editing: boolean; editingExisting?: boolean; draftName?: string | undefined;
  microsoft: {connected: boolean; email?: string | undefined; clientId?: string | undefined; tenantId?: string | undefined; mail: boolean; calendar: boolean};
  tools: {daily: boolean; proactive?: boolean | undefined; github?: {account: string; authorizationEnv: string} | undefined; web?: {apiKeyEnv: string} | undefined};
  google: {connected: boolean; email?: string | undefined; mail: boolean; drive: boolean};
  provider: ProviderSummary | null;
  calendar: {connected: boolean; allowCreate: boolean; email?: string | undefined; pending: boolean; available: boolean};
  telegram: {configured: boolean; pending: boolean; candidate?: string | undefined; url?: string | undefined};
  connections: ({id: string; agents: {id: string; name: string}[]; draft: boolean; label: string} & Partial<ProviderSummary>)[];
  profiles: {id: string; name: string; active: boolean; connectionId?: string | undefined; provider: ProviderSummary | null;
    integrations: {microsoft: boolean; microsoftEmail?: string | undefined; outlookMail: boolean; outlookCalendar: boolean; daily: boolean; github: boolean; web: boolean; mail: boolean; drive: boolean; calendar: boolean; calendarEmail?: string | undefined; telegram: boolean}}[];
}
export interface CodeProject {id: string; workspace: string; connectionId: string; label: string}
export interface CodeProjectState {projects: CodeProject[]; active?: string | undefined; ready: boolean; error: string | null}
/** Metadata of the loaded runtime. A changed binding never authorizes resuming an old run. */
export interface ApplicationRuntimeBinding {fingerprint: string; tools: string[]; contextFingerprint: string}
export interface ApplicationCatalogSnapshot {
  schemaVersion: 1; generation: string; revision: string; locked: boolean;
  agents: AssistantSetupState['profiles']; connections: AssistantSetupState['connections']; projects: CodeProjectState;
  runtimes: {area: 'assistant' | 'code'; id: string; projectId: string; binding: ApplicationRuntimeBinding}[];
}
export interface ApplicationError {schemaVersion: 1; code: string; recovery: 'upgrade' | 'refresh' | 'reconcile' | 'review-request'}
export type CoordinatorMethod = 'reply-watch-proposal' | 'mail-draft-proposal' | 'catalog' | 'calendar-create-proposal' | 'notes' | 'agenda' | 'authorization' | 'automation' | 'personal-state' | 'management' | 'state' | 'shutdown' | 'shutdown-summary' | 'action' | 'code-configure' | 'code-open' | 'code-select' | 'code-retry' | 'code-tools' | 'code-delivery';
export interface ApplicationHello {version: 1; projectionVersion: 1; activityVersion: 1; generation: string; capabilities: string[]}
