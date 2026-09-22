import { FileDiff } from "./FileDiff.js";
import { useState } from "react";
import type { ApprovalDecisionView } from "../../src/internal/desktop/protocol.js";
const labels: Record<ApprovalDecisionView["status"], string> = { rejected: "Rejected", approved: "Approved · no execution evidence", applied: "Applied", succeeded: "Completed", failed: "Failed", unknown: "Unconfirmed result" };
export function DecisionHistory({ projectKey, sessionId, runId }: { projectKey: string; sessionId: string; runId: string }) {
    const [rows, setRows] = useState<ApprovalDecisionView[]>(), [next, setNext] = useState<number>(), [loading, setLoading] = useState(false), [error, setError] = useState(false);
    async function load(offset = 0) { setLoading(true); setError(false); try { const response = await window.harness.command(projectKey, { method: "run.get", sessionId, runId, decisionOffset: offset, includeDiff: true }); if (!response.ok || response.data.kind !== "run") throw new Error(); const incoming = response.data.run.decisions ?? []; setRows(previous => offset === 0 ? incoming : [...(previous ?? []), ...incoming]); setNext(response.data.run.decisionNextOffset); } catch { setError(true); } finally { setLoading(false); } }
    return <section className="decision-history" aria-label="Decision history"><button type="button" className="secondary" data-action="decision-history" disabled={loading} onClick={() => void load()}>Decision history</button>
        {error ? <p role="alert">Could not retrieve the history. Try loading it again.</p> : null}
        {rows?.length === 0 ? <p>This service has no recorded decisions for this run.</p> : null}
        {rows?.map(row => <article key={`${row.approvalId}:${row.digest}`} data-decision-status={row.status}>
            <h4>{row.name} · {labels[row.status]}</h4><p>Review {row.reviewedRevision} · {new Date(row.decidedAt).toLocaleString("en-US")}</p><p className="status">Approval {row.approvalId} · digest {row.digest}</p>
            {row.evidence?.proposalId ? <p className="status">Applied patch: {row.evidence.proposalId}</p> : null}
            {row.evidence?.effects?.map((effect, i) => <p className="status" key={i}>{effect.path}<br />Base: {effect.beforeDigest ?? "missing"}<br />Result: {effect.afterDigest ?? "missing"}</p>)}
            {row.finalDiff?.status === "unavailable" ? <p>Final diff unavailable: no complete saved content matches the evidence.</p> : null}
            {row.finalDiff?.status === "complete" ? <details className="final-diff" data-action="final-diff"><summary>View applied change</summary><p>Saved content of the change applied by this decision.</p>{row.finalDiff.redacted ? <p>Some data is hidden. Digests correspond to the original files.</p> : null}{row.finalDiff.files.map(file => <section className="review-file" key={file.path}><h5>{file.path}</h5>{file.beforeMode !== undefined || file.afterMode !== undefined ? <p>Permissions: {file.beforeMode?.toString(8) ?? "missing"} → {file.afterMode?.toString(8) ?? "missing"}</p> : null}<FileDiff before={file.before ?? undefined} after={file.after ?? undefined} /></section>)}</details> : null}
            {row.evidence?.exitCode !== undefined ? <><p>Check · exit {row.evidence.exitCode}{row.evidence.timedOut ? " · timed out" : ""}</p>{row.evidence.verifiedPatchId ? <p className="status">Verified for patch {row.evidence.verifiedPatchId}<br />{JSON.stringify(row.evidence.command)}</p> : <p>This check does not certify a specific patch.</p>}</> : null}
        </article>)}
        {next !== undefined ? <button type="button" className="secondary" disabled={loading} onClick={() => void load(next)}>View more decisions</button> : null}
    </section>;
}
