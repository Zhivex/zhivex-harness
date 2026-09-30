/** Versioned before execution; changing tasks or thresholds creates a different cohort. */
export const ACCEPTANCE_REVISION = "harness-tasks-v1";
export const ACCEPTANCE_LIMITS = Object.freeze({ maxSteps: 16, timeoutMs: 150_000,
  maxInputTokens: 60_000, maxOutputTokens: 8192, maxTotalTokens: 68_192, maxToolCalls: 40 });
export type AcceptanceMode = "repair" | "failed-check" | "correction" | "restart" | "approval" | "cancellation";
export interface AcceptanceFixture {
  id: string;
  mode: AcceptanceMode;
  files: Record<string, string>;
  editable: string[];
  task: string;
  oracle: string;
  correction?: string;
}
const money = "export function cents(amount) { return Math.floor(amount * 100); }\n";
const oracle = "import assert from 'node:assert/strict'; import {cents} from './src/money.js'; assert.equal(cents(1.005),101); assert.equal(cents(10.075),1008); assert.equal(cents(0),0); assert.equal(cents(1.23),123);\n";
const bug = {
  files: { "src/money.js": money },
  editable: ["src/money.js"],
  task: "Fix decimal currency rounding in src/money.js for nonnegative amounts. Read it, run the failing test before editing, repair it, and run test again. Do not modify tests or package.json.",
  oracle
};
export const ACCEPTANCE_FIXTURES: readonly AcceptanceFixture[] = [
  { ...bug, id: "bug", mode: "repair" },
  { id: "multi-file", mode: "repair", files: { "src/pricing.js": "export function subtotal(items) { return items.reduce((sum,item)=>sum+item.unitCents*item.quantity,0); }\n", "src/index.js": "export {subtotal} from './pricing.js';\n" },
    editable: ["src/pricing.js", "src/index.js"],
    task: "Implement total(items, discountPercent=0) in src/pricing.js and export it from src/index.js. Preserve subtotal. Round discounted subtotal to nearest integer cent. Reject discounts outside [0,100] with RangeError. Run test before and after; do not modify tests or package.json.",
    oracle: "import assert from 'node:assert/strict'; import * as cart from './src/index.js'; assert.equal(cart.subtotal([{unitCents:199,quantity:2}]),398); assert.equal(cart.total([{unitCents:199,quantity:2}],10),358); assert.equal(cart.total([],0),0); assert.equal(cart.total([{unitCents:100,quantity:1}],100),0); assert.throws(()=>cart.total([],101),RangeError); assert.throws(()=>cart.total([],-1),RangeError);\n" },
  { ...bug, id: "failed-check", mode: "failed-check" },
  { ...bug, id: "user-correction", mode: "correction", correction: "Correction: also support negative refunds with symmetric rounding away from zero at half a cent: cents(-1.005)=-101 and cents(-10.075)=-1008. Preserve existing positive results and change only src/money.js. Do not modify tests.",
    oracle: oracle + "assert.equal(cents(-1.005),-101); assert.equal(cents(-10.075),-1008);\n" },
  { ...bug, id: "compaction-restart", mode: "restart" },
  { ...bug, id: "approval", mode: "approval" },
  { ...bug, id: "cancellation", mode: "cancellation" }
];

/** Contract-enforced OCI cohort. Keep distinct from provider-quality/live task scores. */
export const OCI_ACCEPTANCE_REVISION = 'harness-task-contract-oci-v1';
export const OCI_ACCEPTANCE_FIXTURES = [
  {id:'success',expectedAcceptance:'verified',hostImport:true},
  {id:'human-review',expectedAcceptance:'pending_review',hostImport:true},
  {id:'missing-check',expectedAcceptance:'failed',hostImport:false},
  {id:'snapshot-drift',expectedAcceptance:'failed',hostImport:false},
  {id:'scope',expectedAcceptance:'failed',hostImport:false},
  {id:'altered-script',expectedAcceptance:'failed',hostImport:false},
  {id:'altered-test',expectedAcceptance:'failed',hostImport:false},
  {id:'stale-patch',expectedAcceptance:'failed',hostImport:false},
  {id:'post-check-drift',expectedAcceptance:'failed',hostImport:false}
] as const;

/** Structured read-only delegation cohort; fixture models are not live route certification. */
export const DELEGATION_ACCEPTANCE_REVISION='harness-delegation-results-v1';
export const DELEGATION_ACCEPTANCE_FIXTURES=[
  {id:'valid',accepted:true},{id:'invented',accepted:false},{id:'partial',accepted:false},
  {id:'tool-error',accepted:false},{id:'invalid',accepted:false},{id:'corrected',accepted:true},
  {id:'exhausted',accepted:false},{id:'cancellation',accepted:false},{id:'correction-cancel',accepted:false}
] as const;
