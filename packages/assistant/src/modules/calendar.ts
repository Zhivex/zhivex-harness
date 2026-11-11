import { openCalendarConnection, type CalendarConnectionOptions } from '../calendar/connection.js';
import { createCalendarService } from '../calendar/calendar.js';
import { calendarEngineOptions, calendarApprovalDetails } from '../calendar/tools.js';
import type { AssistantModule } from './module.js';

export function createCalendarModule(options: CalendarConnectionOptions): AssistantModule {
  return { id: 'calendar', version: '1', async open(context) {
    const connection = await openCalendarConnection(context.directory, context.ownerId, options, context.recover);
    try {
      const calendar = createCalendarService(connection.store, connection.oauth, options);
      const engine = calendarEngineOptions(calendar);
      return { binding: calendar.binding, preserveProfile: true, profile: engine.agentProfile, mcpConfiguration: engine.mcpConfiguration,
        mcpClients: engine.mcpClients, reviewTools: ['calendar_write_apply'], approvalDetails: calendarApprovalDetails(calendar),
        agendaSource: { binding: calendar.binding, calendarId: options.calendarId ?? 'primary', list: calendar.list }, close: connection.close };
    } catch (error) { await connection.close(); throw error; }
  } };
}
