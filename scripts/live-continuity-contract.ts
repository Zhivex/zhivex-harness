import type { HarnessProvider } from '../src/runtime/config.js';
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

/** Keep the historical default cohort; new routes require explicit selection. */
export function selectContinuityProviders(env:NodeJS.ProcessEnv,available:readonly HarnessProvider[]):HarnessProvider[] {
  const configured=env.ZHIVEX_HARNESS_LIVE_PROVIDERS;
  const selected=configured===undefined?['openai','qwen','meta']:[...new Set(configured.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean))];
  if(!selected.length || selected.some(provider=>!available.includes(provider as HarnessProvider)))throw new Error('Continuity provider selection is empty or unavailable in the selected artifact.');
  return selected as HarnessProvider[];
}
