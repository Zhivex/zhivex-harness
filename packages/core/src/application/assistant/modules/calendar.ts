import { openCalendarConnection, type CalendarConnectionOptions } from '../calendar/connection.js';
import { createCalendarService } from '../calendar/calendar.js';
import { calendarEngineOptions, calendarApprovalDetails } from '../calendar/tools.js';
import type { AssistantModule } from './module.js';

export function createCalendarModule(options: CalendarConnectionOptions): AssistantModule {
  return { id: 'calendar', version: options.allowCreate ? '2' : '1', async open(context) {
    const connection = await openCalendarConnection(context.directory, context.ownerId, options, context.recover);
    try {
      const calendar = createCalendarService(connection.store, connection.oauth, options);
      const engine = calendarEngineOptions(calendar, options.allowCreate);
      return { binding: calendar.binding + (options.allowCreate ? ':create-v1' : ''), preserveProfile: true, profile: engine.agentProfile, mcpConfiguration: engine.mcpConfiguration,
        mcpClients: engine.mcpClients, reviewTools: ['calendar_write_apply', ...(options.allowCreate ? ['calendar_write_create'] : [])], approvalDetails: calendarApprovalDetails(calendar),
        ...(options.allowCreate ? {prepareCalendarCreation: (input: unknown) => calendar.creation.reference(calendar.creation.propose(input))} : {}),
        agendaSource: {canCreate: options.allowCreate === true, binding: calendar.binding, calendarId: options.calendarId ?? 'primary', list: calendar.list }, close: connection.close };
    } catch (error) { await connection.close(); throw error; }
  } };
}
