/** Node client entrypoint; does not import the runtime or host implementation. */
export { connectApplication } from "../application/client.js";
export type { ApplicationClient, ApplicationCommand } from "../application/client.js";
export { readHarnessLocalCredentials } from "../client/local-transport.js";

export { connectCoordinator, ApplicationCoordinatorError } from '../application/coordinator-client.js';
export type { CoordinatorSnapshot, CoordinatorMethod } from '../application/coordinator-client.js';
export type { PersonalSnapshot } from '../application/personal-state.js';

export type {AutomationSnapshot, AutomationChange} from '../application/automation.js';

export type {AgendaSnapshot} from '../application/agenda.js';

export type { NotesSnapshot } from '../application/notes.js';

export type {CodeContextSnapshot} from '../application/code/context.js';
