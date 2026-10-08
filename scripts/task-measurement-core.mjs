// Evaluation arithmetic only. No product state or human acceptance authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function quantiles(samples) {
  assert(samples.every(n => Number.isFinite(n) && n >= 0), 'Invalid latency');
  const ordered = [...samples].sort((a,b) => a-b), n = ordered.length;
  return { n, min: ordered[0] ?? null, p50: n ? ordered[Math.ceil(n*.5)-1] : null,
    p95: n ? ordered[Math.ceil(n*.95)-1] : null, max: ordered.at(-1) ?? null };
}
export function costs(entries, acceptedTaskIds) {
  const categories = ['attempt','retry','compaction','review','routing','child','infrastructure'];
  const ids = new Set(), accepted = new Set(acceptedTaskIds), tasks = new Set();
  let knownSpend = 0;
  const unknown = [], notApplicable = [];
  for (const row of entries) {
    assert(row.id && !ids.has(row.id), 'Duplicate cost receipt'); ids.add(row.id);
    assert(row.taskId && categories.includes(row.category), 'Unsupported cost row'); tasks.add(row.taskId);
    assert(['known','unknown','not_applicable'].includes(row.status), 'Missing cost status');
    if(row.status === 'known') { assert(row.currency === 'USD' && Number.isFinite(row.amount) && row.amount >= 0, 'Invalid known amount'); knownSpend += row.amount; }
    else { assert(row.amount === null && typeof row.reason === 'string' && row.reason.length > 0, 'Unknown is not zero'); (row.status === 'unknown' ? unknown : notApplicable).push(row.id); }
  }
  assert([...accepted].every(id => tasks.has(id)), 'Accepted task missing ledger');
  return { knownSpend, currency:'USD', acceptedTasks:accepted.size, entries:entries.length,
    unknown, notApplicable, unusedCategories:categories.filter(c=>!entries.some(r=>r.category===c)),
    costPerAcceptedTask: accepted.size === 0 || unknown.length || notApplicable.length ? null : knownSpend/accepted.size,
    ratioStatus: accepted.size === 0 ? 'undefined_zero_accepted' : unknown.length ? 'unknown_material_cost' : notApplicable.length ? 'not_applicable' : 'known' };
}
export function evidenceVerdict(evidence, actualDigest) {
  const errors = [];
  if (!evidence || evidence.schemaVersion !== 1) return { accepted:false, errors:['UNSUPPORTED_EVIDENCE'] };
  if (evidence.artifactSha256 !== actualDigest) errors.push('STALE_ARTIFACT');
  if (evidence.structure !== 'verified' || evidence.correspondence !== 'current') errors.push('INCOMPLETE_STRUCTURE');
  if (!Array.isArray(evidence.checks) || evidence.checks.length !== 1 || evidence.checks[0]?.id !== 'test' || evidence.checks[0]?.status !== 'confirmed') errors.push('CHECK_NOT_CONFIRMED');
  if (evidence.protectedIntact !== true) errors.push('PROTECTED_DRIFT');
  if (evidence.unknownEffects !== 0 || evidence.missingEvidence !== false) errors.push('UNKNOWN_EFFECT');
  if (evidence.support !== 'host_durable_contract_journal_budget_and_fresh_native_snapshot') errors.push('UNSUPPORTED_CLAIM');
  if (evidence.reportedVisibleOutput !== evidence.observedVisibleOutput) errors.push('ALTERED_REPORTED_OUTPUT');
  if (!['string','number'].includes(typeof evidence.observedVisibleOutput)) errors.push('MISSING_OUTPUT');
  return { accepted:errors.length === 0, errors };
}
export function negativeEvidence(evidence) {
  return [
    ['stale', {artifactSha256:'0'.repeat(64)}], ['incomplete',{checks:[]}],
    ['unsupported',{support:'https://example.invalid/fake-citation'}],
    ['altered-output',{reportedVisibleOutput:typeof evidence.observedVisibleOutput === 'number' ? evidence.observedVisibleOutput+1 : 'incorrect'}],
    ['protected-drift',{protectedIntact:false}], ['unknown-effect',{unknownEffects:1}]
  ].map(([id,patch])=>({id,evidence:{...evidence,...patch}}));
}

export function validateOracle(value, moduleSha256, casesSha256) {
  assert(value && typeof value.accepted === 'boolean' && Array.isArray(value.failures) && Array.isArray(value.observed), 'Malformed oracle verdict');
  assert(value.failures.every(item => typeof item === 'string' && item.length > 0), 'Malformed oracle failures');
  assert.equal(value.accepted, value.failures.length === 0, 'Inconsistent oracle verdict');
  assert.equal(value.moduleSha256, moduleSha256, 'Oracle module binding mismatch');
  assert.equal(value.casesSha256, casesSha256, 'Oracle cases binding mismatch');
  return value;
}
