import type {ZhivexHarness} from '../runtime/harness.js';
import type {ApplicationRuntimeBinding} from './contracts.js';
/** Only immutable identity and tool names cross the presentation boundary. */
export function applicationRuntimeBinding(harness: ZhivexHarness): ApplicationRuntimeBinding {
  const fingerprint = harness.agent.harness?.fingerprint;
  if (!fingerprint) throw new Error('APPLICATION_BINDING_UNAVAILABLE');
  return {fingerprint, tools: Object.keys(harness.agent.tools ?? {}).sort(), contextFingerprint: harness.context.fingerprint};
}
