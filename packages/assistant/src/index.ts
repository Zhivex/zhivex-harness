export * from "./contracts.js";
export { createAssistantRuntime } from "./runtime.js";
export type { AssistantRuntimeOptions } from "./runtime.js";
export { startAssistantHost } from "./host.js";
export type { AssistantHostOptions } from "./host.js";
export { connectAssistant } from "./client.js";
export type { AssistantCommand } from "./client.js";
export { createTelegramBridge } from "./telegram/bridge.js";
export type { TelegramBridgeOptions } from "./telegram/bridge.js";
export { createTelegramApi, TelegramFailure } from "./telegram/api.js";
export type { TelegramApi } from "./telegram/api.js";

export { openCalendarConnection } from "./calendar/connection.js";
export type { CalendarConnectionOptions } from "./calendar/connection.js";
export { createCalendarService, proposalSchema, changeSchema } from "./calendar/calendar.js";
export type { CalendarProposal } from "./calendar/calendar.js";
export { calendarEngineOptions } from "./calendar/tools.js";
export { createCalendarOAuth, startCalendarAuthorization, CALENDAR_SCOPE } from "./calendar/oauth.js";

export type { AgendaSource, AgendaEvent } from "./automation/summary.js";

export { createCalendarModule } from "./modules/calendar.js";
export { createMcpModule } from "./modules/mcp.js";
export type { AssistantModule, AssistantModuleContext, AssistantModuleInstance } from "./modules/module.js";
export { createCompatibleProvider, parseCompatibleProvider } from "./providers/openai-compatible.js";
export type { CompatibleProviderConfig } from "./providers/openai-compatible.js";

export { loadAssistantConfig } from "./config.js";

export { startAssistantWeb } from "./web/server.js";
export type { AssistantWebOptions, WebHost } from "./web/server.js";

export { createAssistantProvider, parseAssistantProvider } from './providers/provider.js';
export type { AssistantProviderConfig } from './providers/provider.js';

export { taskFeedbackSchema, taskLinkSchema, taskCategorySchema } from "./task-metrics.js";
