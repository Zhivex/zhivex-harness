import type { HarnessProvider } from '../src/runtime/config.js';
import { isRetryableProviderFailure } from '../src/runtime/provider-transient.js';
import { HarnessConfigError, HarnessExecutionError } from '../src/runtime/errors.js';
import { diagnosticFingerprint, parseSanitizedOperationalError, sanitizeOperationalError } from './release-diagnostics.js';
import { createHash } from 'node:crypto';
import { errorDetailsSchema } from '../src/runtime/error-diagnostics.js';
import type { AgentStreamEvent, TokenUsage } from '@zhivex-ai/core';

const checks = ['completed', 'compacted', 'codename', 'compatibility', 'rejectedApproach', 'objective', 'noTools'] as const;
const fields = ['codename', 'compatibility', 'rejectedApproach', 'objective'] as const;
const evidenceSchema = errorDetailsSchema.shape.chain.element.shape.continuity.unwrap().shape.evidence.unwrap();

/** Retain counts and a digest only; never raw events, arbitrary keys or provider strings. */
export function createContinuityEvidence() {
  const counts = { textEvents: 0, textBytes: 0, finishEvents: 0, errorEvents: 0 };
  const bounded = (value: number, max = 1_000_000_000) => Math.min(max, Math.max(0, value));
  const tokens = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? bounded(value!) : null;
  const reason = (value: unknown) => value === undefined ? 'unavailable' as const
    : ['stop', 'length', 'tool-calls', 'content-filter'].includes(String(value)) ? value as 'stop' | 'length' | 'tool-calls' | 'content-filter' : 'other' as const;
  let usage: TokenUsage | undefined;
  let finishReason: unknown;
  return {
    observe(event: AgentStreamEvent) {
      if (event.type === 'text-delta') {
        counts.textEvents = bounded(counts.textEvents + 1, 1_000_000);
        counts.textBytes = bounded(counts.textBytes + Buffer.byteLength(event.textDelta));
      } else if (event.type === 'finish') {
        counts.finishEvents = bounded(counts.finishEvents + 1, 1_000_000);
        usage = event.usage;
        finishReason = event.finishReason;
      } else if (event.type === 'error') counts.errorEvents = bounded(counts.errorEvents + 1, 1_000_000);
    },
    snapshot(result?: { outputText: string; usage?: TokenUsage; finishReason?: unknown }) {
      let answerShape: 'invalid_json' | 'object' | 'array' | 'null' | 'primitive' | 'unavailable' = 'unavailable';
      let knownFields: typeof fields[number][] = [];
      let extraFieldCount = 0;
      if (result) {
        try {
          const answer: unknown = JSON.parse(result.outputText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
          answerShape = answer === null ? 'null' : Array.isArray(answer) ? 'array' : typeof answer === 'object' ? 'object' : 'primitive';
          if (answerShape === 'object') {
            const keys = Object.keys(answer as object);
            knownFields = fields.filter(field => keys.includes(field));
            extraFieldCount = bounded(keys.length - knownFields.length, 1_000_000);
          }
        } catch { answerShape = 'invalid_json'; }
      }
      const receipt = result?.usage ?? usage;
      return evidenceSchema.parse({ answerShape, knownFields, extraFieldCount,
        responseBytes: result ? bounded(Buffer.byteLength(result.outputText)) : 0,
        ...(result ? { responseSha256: createHash('sha256').update(result.outputText).digest('hex') } : {}),
        ...counts, finishReason: reason(result?.finishReason ?? finishReason),
        inputTokens: tokens(receipt?.inputTokens), outputTokens: tokens(receipt?.outputTokens),
        reasoningTokens: tokens(receipt?.reasoningTokens), totalTokens: tokens(receipt?.totalTokens) });
    }
  };
}

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
    const evidence = evidenceSchema.safeParse(failed?.evidence);
    projection.details = { ...projection.details, chain: [{ checkpoint: 'continuity_phase' as const, continuity: {
      phase: Number(failed!.phase), failedChecks: checks.filter(check => phaseChecks[check] === false),
      ...(evidence.success ? { evidence: evidence.data } : {})
    } }, ...(projection.details?.chain ?? [])].slice(0, 5) };
  }
  return { provider, ok: false as const, error: parseSanitizedOperationalError({
    ...projection, fingerprint: diagnosticFingerprint(projection)
  }) };
}

/**
 * Retry a continuity phase only for a provider outage or a turn that produced
 * no text and no finish. A completed answer that fails a fact check stays failed.
 */
export function continuityPhaseShouldRetry(phase: Record<string, unknown> | undefined): boolean {
  if (!phase) return true;
  if (phase.status === "passed") return false;
  if (phase.diagnostic !== undefined && isRetryableProviderFailure(phase.diagnostic)) return true;
  const evidence = phase.evidence;
  if (!evidence || typeof evidence !== "object") return false;
  const record = evidence as Record<string, unknown>;
  return record.finishEvents === 0 && record.textEvents === 0 && record.textBytes === 0 && record.responseBytes === 0;
}

/** One full, fresh rerun per provider; every provider must still pass. */
export const CONTINUITY_PROVIDER_ATTEMPTS = 2;

/** Sanitized cause of a failed provider attempt: classification only, never provider text. */
export function continuityAttemptSummary(row: Record<string, unknown>) {
  const outcome = continuityGateOutcome(row);
  if (outcome.ok) return { status: 'passed' as const };
  const error = outcome.error!;
  const continuity = error.details?.chain?.find(entry => entry.checkpoint === 'continuity_phase')?.continuity;
  return { status: row.status === 'missing_credentials' ? 'missing_credentials' as const : 'failed' as const,
    code: error.code, ...(error.category ? { category: error.category } : {}), retryable: error.retryable,
    fingerprint: error.fingerprint, phase: continuity?.phase ?? null, failedChecks: continuity?.failedChecks ?? [],
    finishReason: continuity?.evidence?.finishReason ?? 'unavailable' };
}

/**
 * Model sampling makes a single six-phase run flaky for an otherwise healthy
 * route. A failed provider run is repeated once from a fresh session; the
 * provider passes only if that retry passes. Missing credentials never retry.
 */
export async function runContinuityProviderWithRetry(provider: string,
  runAttempt: (attempt: number) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const first = await runAttempt(1);
  if (first.status === 'passed' || first.status === 'missing_credentials') return { ...first, provider, attempts: 1 };
  const retry = await runAttempt(2);
  return { ...retry, provider, attempts: CONTINUITY_PROVIDER_ATTEMPTS, retry: {
    firstAttempt: continuityAttemptSummary({ ...first, provider }),
    outcome: retry.status === 'passed' ? 'passed' : 'failed' } };
}

/** One bounded log line per retried provider for the workflow step summary. */
export function continuityRetrySummaryLines(rows: readonly Record<string, unknown>[]): string[] {
  return rows.flatMap(row => {
    const retry = row.retry as { firstAttempt: ReturnType<typeof continuityAttemptSummary>; outcome: string } | undefined;
    if (!retry) return [];
    const first = retry.firstAttempt;
    const cause = first.status === 'passed' ? 'passed' : `${first.code}, phase ${first.phase ?? 'n/a'}, failed checks ` +
      `[${first.failedChecks.join(', ')}], finishReason ${first.finishReason}, fingerprint ${first.fingerprint}`;
    return [`Continuity retry: ${String(row.provider)} first attempt failed (${cause}); retry ${retry.outcome}.`];
  });
}

/** Keep the historical default cohort; new routes require explicit selection. */
export function selectContinuityProviders(env:NodeJS.ProcessEnv,available:readonly HarnessProvider[]):HarnessProvider[] {
  const configured=env.ZHIVEX_HARNESS_LIVE_PROVIDERS;
  const selected=configured===undefined?['openai','qwen','meta']:[...new Set(configured.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean))];
  if(!selected.length || selected.some(provider=>!available.includes(provider as HarnessProvider)))throw new Error('Continuity provider selection is empty or unavailable in the selected artifact.');
  return selected as HarnessProvider[];
}
