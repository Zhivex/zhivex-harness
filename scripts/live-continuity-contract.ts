import type { HarnessProvider } from '../src/runtime/config.js';
import { HarnessConfigError, HarnessExecutionError } from '../src/runtime/errors.js';
import { diagnosticFingerprint, parseSanitizedOperationalError, sanitizeOperationalError } from './release-diagnostics.js';

const checks = ['completed', 'compacted', 'codename', 'compatibility', 'rejectedApproach', 'objective', 'noTools'] as const;

/** Project the host's phase report into the release wrapper's JSON contract. */
export function continuityGateOutcome(row: Record<string, unknown>) {
  const provider = row.provider as HarnessProvider;
  if (row.status === 'passed') return { provider, ok: true as const };
  if (row.status === 'missing_credentials') return { provider, ok: false as const,
    error: sanitizeOperationalError(new HarnessConfigError('Continuity route is not configured.')) };
  const phases = Array.isArray(row.phases) ? row.phases as Record<string, unknown>[] : [];
  const failed = phases.find(phase => phase.status !== 'passed');
  let safe = sanitizeOperationalError(new HarnessExecutionError('Continuity phase failed.'));
  if (failed?.diagnostic) {
    try { safe = parseSanitizedOperationalError(failed.diagnostic); } catch { /* Fail closed without raw fields. */ }
  }
  const { fingerprint: _fingerprint, ...projection } = safe;
  if (Number.isSafeInteger(failed?.phase) && Number(failed?.phase) >= 0 && Number(failed?.phase) < 6) {
    const phaseChecks = failed?.checks && typeof failed.checks === 'object' ? failed.checks as Record<string, unknown> : {};
    projection.details = { ...projection.details, chain: [{ checkpoint: 'continuity_phase' as const, continuity: {
      phase: Number(failed!.phase), failedChecks: checks.filter(check => phaseChecks[check] === false)
    } }, ...(projection.details?.chain ?? [])].slice(0, 5) };
  }
  return { provider, ok: false as const, error: parseSanitizedOperationalError({
    ...projection, fingerprint: diagnosticFingerprint(projection)
  }) };
}

/** Keep the historical default cohort; new routes require explicit selection. */
export function selectContinuityProviders(env:NodeJS.ProcessEnv,available:readonly HarnessProvider[]):HarnessProvider[] {
  const configured=env.ZHIVEX_HARNESS_LIVE_PROVIDERS;
  const selected=configured===undefined?['openai','qwen','meta']:[...new Set(configured.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean))];
  if(!selected.length || selected.some(provider=>!available.includes(provider as HarnessProvider)))throw new Error('Continuity provider selection is empty or unavailable in the selected artifact.');
  return selected as HarnessProvider[];
}
