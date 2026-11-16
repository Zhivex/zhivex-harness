import {z} from 'zod';
import type {ManagedApplication} from './coordinator-client.js';

const requestSchema = z.object({resource: z.enum(['agents', 'connections', 'projects']), action: z.string(), args: z.array(z.string()).max(3), input: z.unknown().optional(), confirmed: z.boolean().optional()}).strict();
/** Shared management operations. The coordinator serializes these with setup and project changes. */
export async function manageApplication(manager: ManagedApplication, raw: unknown) {
  const {resource, action, args, input, confirmed} = requestSchema.parse(raw);
  if (resource !== 'projects' && manager.state().locked) throw new Error('SETUP_KEYCHAIN_UNAVAILABLE');
  const arity = (count: number) => {if (args.length !== count) throw new Error('APPLICATION_ARGUMENTS_INVALID');};
  if (resource === 'agents') {
    switch(action) {
      case 'list': arity(0); break;
      case 'create': arity(1); if (manager.state().editing) throw new Error('SETUP_DRAFT_PENDING'); await manager.action('begin', {name: args[0]}); break;
      case 'tools': arity(0); await manager.action('tools', input); break;
      case 'start': arity(0); await manager.action('start', {}); break;
      case 'select': arity(1); await manager.action('select', {id: args[0]}); break;
      case 'rename': arity(2); await manager.action('rename', {id: args[0], name: args[1]}); break;
      case 'model': arity(2); await manager.action('model', {id: args[0], model: args[1]}); break;
      case 'discard': arity(0); if (!confirmed) throw new Error('APPLICATION_CONFIRMATION_REQUIRED'); await manager.action('discard', {}); break;
      case 'delete': arity(1); if (!confirmed) throw new Error('APPLICATION_CONFIRMATION_REQUIRED'); await manager.action('delete-agent', {id: args[0]}); break;
      default: throw new Error('APPLICATION_ACTION_INVALID');
    }
    const state = manager.state();
    return {schemaVersion: 1 as const, kind: 'application-agents' as const, agents: state.profiles, draft: state.editing ? {name: state.draftName, tools: state.tools} : null, ready: state.ready};
  }
  if (resource === 'connections') {
    switch(action) {
      case 'list': arity(0); break;
      case 'configure': arity(0); await manager.action('provider', input); break;
      case 'use': arity(1); await manager.action('reuse-provider', {id: args[0]}); break;
      default: throw new Error('APPLICATION_ACTION_INVALID');
    }
    return {schemaVersion: 1 as const, kind: 'application-connections' as const, connections: manager.state().connections};
  }
  switch(action) {
    case 'list': arity(0); break;
    case 'open': arity(2); await manager.codeProjects.open(args[0]!, args[1]!); break;
    case 'connection': arity(2); await manager.codeProjects.configure(args[0]!, args[1]!); break;
    case 'select': arity(1); await manager.codeProjects.select(args[0]!); break;
    default: throw new Error('APPLICATION_ACTION_INVALID');
  }
  return {schemaVersion: 1 as const, kind: 'application-projects' as const, ...manager.codeProjects.state()};
}
