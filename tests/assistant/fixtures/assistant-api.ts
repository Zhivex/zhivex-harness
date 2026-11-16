export * from "../../../packages/core/src/engine/assistant/contracts.js";
export { createAssistantRuntime } from "../../../packages/core/src/engine/assistant/runtime.js";
export type { AssistantRuntimeOptions } from "../../../packages/core/src/engine/assistant/runtime.js";
export { startAssistantHost } from "../../../packages/core/src/engine/assistant/host.js";
export type { AssistantHostOptions } from "../../../packages/core/src/engine/assistant/host.js";
export { connectAssistant } from "../../../packages/core/src/engine/assistant/client.js";
export type { AssistantCommand } from "../../../packages/core/src/engine/assistant/client.js";
export { createTelegramBridge } from "../../../packages/core/src/engine/assistant/telegram/bridge.js";
export type { TelegramBridgeOptions } from "../../../packages/core/src/engine/assistant/telegram/bridge.js";
export { createTelegramApi, TelegramFailure } from "../../../packages/core/src/engine/assistant/telegram/api.js";
export type { TelegramApi } from "../../../packages/core/src/engine/assistant/telegram/api.js";

export { openCalendarConnection } from "../../../packages/core/src/engine/assistant/calendar/connection.js";
export type { CalendarConnectionOptions } from "../../../packages/core/src/engine/assistant/calendar/connection.js";
export { createCalendarService, proposalSchema, changeSchema } from "../../../packages/core/src/engine/assistant/calendar/calendar.js";
export type { CalendarProposal } from "../../../packages/core/src/engine/assistant/calendar/calendar.js";
export { calendarEngineOptions } from "../../../packages/core/src/engine/assistant/calendar/tools.js";
export { createCalendarOAuth, startCalendarAuthorization, CALENDAR_SCOPE } from "../../../packages/core/src/engine/assistant/calendar/oauth.js";

export type { AgendaSource, AgendaEvent } from "../../../packages/core/src/engine/assistant/automation/summary.js";

export { createCalendarModule } from "../../../packages/core/src/engine/assistant/modules/calendar.js";
export { createMcpModule } from "../../../packages/core/src/engine/assistant/modules/mcp.js";
export { createDailyModule } from '../../../packages/core/src/engine/assistant/modules/daily.js';
export { createGoogleModule } from '../../../packages/core/src/engine/assistant/modules/google.js';
export { createGithubModule } from '../../../packages/core/src/engine/assistant/modules/github.js';
export { createWebModule } from '../../../packages/core/src/engine/assistant/modules/web.js';
export { openGoogleConnection } from '../../../packages/core/src/engine/assistant/integrations/google.js';
export type { GoogleToolsOptions } from '../../../packages/core/src/engine/assistant/integrations/google.js';
export type { AssistantModule, AssistantModuleContext, AssistantModuleInstance } from "../../../packages/core/src/engine/assistant/modules/module.js";
export { createCompatibleProvider, parseCompatibleProvider } from "../../../packages/core/src/engine/assistant/providers/openai-compatible.js";
export type { CompatibleProviderConfig } from "../../../packages/core/src/engine/assistant/providers/openai-compatible.js";

export { loadAssistantConfig } from "../../../packages/core/src/engine/assistant/config.js";


export { createAssistantProvider, parseAssistantProvider } from '../../../packages/core/src/engine/assistant/providers/provider.js';
export type { AssistantProviderConfig } from '../../../packages/core/src/engine/assistant/providers/provider.js';

export { taskFeedbackSchema, taskLinkSchema, taskCategorySchema } from "../../../packages/core/src/engine/assistant/task-metrics.js";

export { createMicrosoftModule } from '../../../packages/core/src/engine/assistant/modules/microsoft.js';
export { openMicrosoftConnection, startMicrosoftAuthorization } from '../../../packages/core/src/engine/assistant/microsoft/connection.js';
export type { MicrosoftOptions } from '../../../packages/core/src/engine/assistant/microsoft/connection.js';

export type { ReplySource } from '../../../packages/core/src/engine/assistant/proactive/service.js';
