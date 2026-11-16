export * from "../../../dist/engine/assistant/contracts.js";
export { createAssistantRuntime } from "../../../dist/engine/assistant/runtime.js";
export { startAssistantHost } from "../../../dist/engine/assistant/host.js";
export { connectAssistant } from "../../../dist/engine/assistant/client.js";
export { createTelegramBridge } from "../../../dist/engine/assistant/telegram/bridge.js";
export { createTelegramApi, TelegramFailure } from "../../../dist/engine/assistant/telegram/api.js";

export { openCalendarConnection } from "../../../dist/engine/assistant/calendar/connection.js";
export { createCalendarService, proposalSchema, changeSchema } from "../../../dist/engine/assistant/calendar/calendar.js";
export { calendarEngineOptions } from "../../../dist/engine/assistant/calendar/tools.js";
export { createCalendarOAuth, startCalendarAuthorization, CALENDAR_SCOPE } from "../../../dist/engine/assistant/calendar/oauth.js";


export { createCalendarModule } from "../../../dist/engine/assistant/modules/calendar.js";
export { createMcpModule } from "../../../dist/engine/assistant/modules/mcp.js";
export { createDailyModule } from '../../../dist/engine/assistant/modules/daily.js';
export { createGoogleModule } from '../../../dist/engine/assistant/modules/google.js';
export { createGithubModule } from '../../../dist/engine/assistant/modules/github.js';
export { createWebModule } from '../../../dist/engine/assistant/modules/web.js';
export { openGoogleConnection } from '../../../dist/engine/assistant/integrations/google.js';
export { createCompatibleProvider, parseCompatibleProvider } from "../../../dist/engine/assistant/providers/openai-compatible.js";

export { loadAssistantConfig } from "../../../dist/engine/assistant/config.js";


export { createAssistantProvider, parseAssistantProvider } from '../../../dist/engine/assistant/providers/provider.js';

export { taskFeedbackSchema, taskLinkSchema, taskCategorySchema } from "../../../dist/engine/assistant/task-metrics.js";

export { createMicrosoftModule } from '../../../dist/engine/assistant/modules/microsoft.js';
export { openMicrosoftConnection, startMicrosoftAuthorization } from '../../../dist/engine/assistant/microsoft/connection.js';
