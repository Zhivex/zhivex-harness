import type {CodeContextSnapshot} from '../application/code/context.js';
import {z} from 'zod';
import type {AutomationSnapshot} from '../application/automation.js';
import {validZone} from '../application/assistant/automation/time.js';
import {connectApplication} from '../application/client.js';
import type {NotesSnapshot} from '../application/notes.js';
import type {PersonalSnapshot} from '../application/personal-state.js';
import path from 'node:path';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import { connectCoordinator } from '../application/coordinator-client.js';
import { ensureApplicationCoordinator } from '../application/coordinator-discovery.js';
import type { CliOptions } from './arguments.js';
import { HarnessConfigError } from '../runtime/errors.js';
import { sanitizeTerminalText } from './terminal/terminal-ui.js';

export async function useApplicationCli(options: CliOptions): Promise<string | undefined> {
  // Validate before discovery so malformed input cannot start a background host.
  const automationInput = options.command === 'automations' && options.automationCommand === 'apply'
    ? parseAutomationInput(options.managementInput) : undefined;
  const directory = path.resolve(options.applicationDirectory ?? path.join(os.homedir(), '.zhx-app'));
  const lifecycle = options.command === 'application' ? options.applicationCommand : undefined;
  let client: Awaited<ReturnType<typeof connectCoordinator>>;
  try {
    if (lifecycle === 'status' || lifecycle === 'stop') client = await connectCoordinator(directory);
    else {
      const entry = await realpath(process.argv[1]!);
      const launcher = path.join(path.dirname(entry), entry.endsWith('.ts') ? 'service-cli.ts' : 'service-cli.js');
      client = await ensureApplicationCoordinator(directory, {executable: process.execPath, entry: launcher});
    }
  } catch (error) {
    if (lifecycle === 'status' && ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && error.message === 'LOCAL_SERVICE_UNAVAILABLE'))) {
      print({schemaVersion: 1, kind: 'application-status', status: 'unavailable', directory}, options.json); return;
    }
    throw new HarnessConfigError(`Application service unavailable (${error instanceof Error ? error.message : 'unknown'}). Inspect its state before retrying.`);
  }
  if (lifecycle === 'stop') {
    await client.call('shutdown', {confirmed: true});
    print({schemaVersion: 1, kind: 'application-status', status: 'stop-requested', directory}, options.json); return;
  }
  if (options.command === 'projects' && options.managementAction === 'context') {
    if (!client.capabilities.includes('application.code-context')) throw new HarnessConfigError('The running host does not support Code context. Update and restart the host.');
    const snapshot = await client.state();
    if (!snapshot.codeCredentialsPath) throw new HarnessConfigError('No active Code project is ready. Open or select a project first.');
    const code = await connectApplication(snapshot.codeCredentialsPath);
    const context = await client.call<CodeContextSnapshot>('code-tools', {action: 'context', value: {projectId: code.projectId}});
    print({...context, kind: 'application-code-context', projectId: code.projectId}, options.json);
    return;
  }
  if (['agents', 'connections', 'projects'].includes(options.command)) {
    if (!client.capabilities.includes('application.management')) throw new HarnessConfigError('The running application host does not support management commands. Stop it explicitly and restart with the updated version.');
    try {
      const result = await client.call('management', {resource: options.command, action: options.managementAction, args: options.managementArgs ?? [], ...(options.managementInput === undefined ? {} : {input: options.managementInput}), confirmed: options.yes});
      print(result, options.json); return;
    } catch (error) {throw new HarnessConfigError(`Application configuration failed (${error instanceof Error ? error.message : 'unknown'}). Inspect the shared draft and state before retrying.`);}
  }
  const snapshot = await client.state();
  if (options.command === 'automations') {
    if (!client.capabilities.includes('application.automation')) throw new HarnessConfigError('The running host does not support automations. Update and restart the host.');
    if (!snapshot.credentialsPath) throw new HarnessConfigError('No active Assistant is ready. Configure or select an agent first.');
    const assistant = await connectApplication(snapshot.credentialsPath);
    if (automationInput && automationInput.projectId !== assistant.projectId) throw new HarnessConfigError('APPLICATION_SCOPE_CHANGED: review automation status for the active Assistant.');
    try {
      const automation = await client.call<AutomationSnapshot>('automation', {projectId: assistant.projectId, ...(automationInput ? {change: {...automationInput.change, confirmed: true}} : {})});
      print({schemaVersion: 1, kind: 'application-automation', projectId: assistant.projectId, ...automation}, options.json);
    } catch (error) {throw new HarnessConfigError(`Automation configuration failed (${error instanceof Error ? error.message : 'unknown'}). Read automations status before retrying; do not automatically repeat an uncertain change.`);}
    return;
  }
  if (options.command === 'personal') {
    const notesCommand = ['notes', 'search-notes', 'note'].includes(options.personalCommand ?? '');
    if (!client.capabilities.includes(notesCommand ? 'application.notes' : 'application.personal-state')) throw new HarnessConfigError('The running host does not support personal state. Update and restart the host.');
    if (!snapshot.credentialsPath) throw new HarnessConfigError('No active Assistant is ready. Configure or select an agent first.');
    const assistant = await connectApplication(snapshot.credentialsPath);
    if (notesCommand) {
      const notes = await client.call<NotesSnapshot>('notes', {projectId: assistant.projectId, offset: options.personalOffset ?? 0, query: options.personalQuery ?? '', ...(options.personalNoteId ? {noteId: options.personalNoteId} : {})});
      print({schemaVersion: 1, kind: 'application-notes', projectId: assistant.projectId, ...notes}, options.json);
      return;
    }
    const personal = await client.call<PersonalSnapshot>('personal-state', {projectId: assistant.projectId, offset: options.personalOffset ?? 0});
    const base = {schemaVersion: 1, projectId: assistant.projectId, enabled: personal.enabled};
    print(options.personalCommand === 'tasks'
      ? {...base, kind: 'application-tasks', tasks: personal.tasks, total: personal.total, nextOffset: personal.nextOffset}
      : {...base, kind: 'application-reminders', reminders: personal.reminders}, options.json);
    return;
  }
  if (lifecycle) {
    print({schemaVersion: 1, kind: 'application-status', status: 'running', directory, assistantReady: snapshot.state.ready, assistantLocked: snapshot.state.locked, assistantError: snapshot.state.error, codeReady: snapshot.code.ready}, options.json); return;
  }
  const area = options.applicationArea ?? 'assistant';
  const file = area === 'assistant' ? snapshot.credentialsPath : snapshot.codeCredentialsPath;
  if (!file) throw new HarnessConfigError(area === 'assistant' ? 'The shared Assistant is not configured. Configure its agent and connection before running a task.' : 'No shared Code project is open. Select a Git project and model connection before running a task.');
  return file;
}
function print(value: unknown, json: boolean) {const text = JSON.stringify(value, null, 2); process.stdout.write((json ? text : sanitizeTerminalText(text)) + '\n');}

function parseAutomationInput(value: unknown) {
  const common = {expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)};
  const schema = z.object({projectId: z.string().min(1), change: z.discriminatedUnion('action', [
    z.object({...common, action: z.literal('configure'), localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string().refine(validZone)}).strict(),
    z.object({...common, action: z.enum(['pause', 'resume', 'delete', 'forget'])}).strict(),
  ])}).strict();
  const result = schema.safeParse(value);
  if (!result.success) throw new HarnessConfigError('Invalid automation configuration. Supply projectId and change with action and expectedDigest; configure also requires localTime (HH:mm) and a valid timeZone.');
  return result.data;
}
