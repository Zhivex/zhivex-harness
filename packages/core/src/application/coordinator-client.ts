import type {AssistantSetupState, CodeProjectState, ApplicationCatalogSnapshot, ApplicationError, CoordinatorMethod} from './contracts.js';
import path from 'node:path';
import {z} from 'zod';
import { readHarnessLocalCredentials, requestLocalServiceDocument } from '../client/local-transport.js';
import type { startManagedAssistant } from './assistant/managed/setup.js';
export type ManagedApplication = Awaited<ReturnType<typeof startManagedAssistant>>;
export interface CoordinatorSnapshot {
  state: AssistantSetupState;
  credentialsPath?: string | undefined;
  code: CodeProjectState;
  codeCredentialsPath?: string | undefined;
}
export type {CoordinatorMethod} from './contracts.js';

/** Trusted Node client only. Runtime credential paths must never be forwarded to a renderer. */
export async function connectCoordinator(directory: string, options: {versions?: number[]; requiredCapabilities?: string[]} = {}) {
  const credentials = await readHarnessLocalCredentials(path.join(directory, 'coordinator.json'));
  const call = async <T = unknown>(method: CoordinatorMethod | 'hello', input?: unknown): Promise<T> => {
    const result = await requestLocalServiceDocument(credentials, 'application', {version: 1, method, input}, method === 'hello' || method === 'state' ? 3000 : 120_000) as {ok: boolean; result?: T; error?: string; detail?: ApplicationError};
    if (!result.ok) throw new ApplicationCoordinatorError(result.error ?? 'COORDINATOR_RESPONSE_INVALID', result.detail);
    return result.result as T;
  };
  const hello = z.object({version: z.literal(1), projectionVersion: z.literal(1).optional(), activityVersion: z.literal(1).optional(), generation:z.string().uuid().optional(), capabilities: z.array(z.string()).max(100)}).parse(await call('hello', {versions:options.versions ?? [1]}));
  if (options.requiredCapabilities?.some(capability => !hello.capabilities.includes(capability))) throw new ApplicationCoordinatorError('COORDINATOR_CAPABILITY_UNSUPPORTED', {schemaVersion:1, code:'COORDINATOR_CAPABILITY_UNSUPPORTED', recovery:'upgrade'});
  return {call, protocol: hello, capabilities: hello.capabilities, catalog: () => {if (!hello.capabilities.includes('application.catalog')) throw new ApplicationCoordinatorError('COORDINATOR_CAPABILITY_UNSUPPORTED'); return call<ApplicationCatalogSnapshot>('catalog');}, state: () => call<CoordinatorSnapshot>('state')};
}

/** Stable code and recovery metadata; clients must never automatically replay failed mutations. */
export class ApplicationCoordinatorError extends Error {
  readonly code: string; readonly detail: ApplicationError | undefined;
  constructor(code: string, detail?: ApplicationError) {super(code); this.name='ApplicationCoordinatorError'; this.code=code; this.detail=detail;}
}
