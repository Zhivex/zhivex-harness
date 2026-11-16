import type {CodeContextSnapshot} from '../contracts.js';
export type {CodeContextSnapshot} from '../contracts.js';
import {createRedactionPolicy} from '@zhivex-ai/agents';
import type {ZhivexHarness} from '../../runtime/harness.js';

/** Metadata of the host's loaded bundle, never file contents or credential configuration. */
export function projectCodeContext(harness: Pick<ZhivexHarness, 'context' | 'config'>, secrets: readonly string[] = []): CodeContextSnapshot {
  const policy = createRedactionPolicy({includeEmails: true});
  const protect = (value: string) => {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
    return policy.redactText(value).replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi, '[REDACTED]');
  };
  const identity = ({path, digest, bytes}: {path: string; digest: string; bytes: number}) => ({path: protect(path), digest, bytes});
  return {schemaVersion: 1, enabled: harness.config.context.enabled, provider: protect(harness.config.provider), model: protect(harness.config.model), fingerprint: harness.context.fingerprint,
    ...(harness.context.manifest ? {manifest: identity(harness.context.manifest)} : {}),
    sources: harness.context.sources.map(source => ({kind: source.kind, ...identity(source)})),
    skills: harness.context.skills.map(skill => ({id: protect(skill.id), ...identity(skill)}))};
}
