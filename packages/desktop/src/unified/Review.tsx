import {CalendarReview} from './CalendarReview.js';
import { useEffect, useRef, useState } from "react";
import type { TicketedApprovalReview } from "@zhivex-ai/harness/application";
import { FileDiff } from "../FileDiff.js";
import { actionLabel, decisionRecorded } from "../conversation-feedback.js";
import { reviewConsequence, reviewScopeSummary, preventDecisionEnter } from "../review-scope.js";
import { useViewedFiles } from "../review-ui.js";

export function Review({ hostId, sessionId, runId, revision, onDecision, onUncertain, onRefresh, blocked }: {
  hostId: string; sessionId: string; runId: string; revision: number; blocked: boolean; onDecision(): void; onUncertain(): void; onRefresh(): void;
}) {
  const [review, setReview] = useState<TicketedApprovalReview>();
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(blocked);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), generation = useRef(0);
  const viewed = useViewedFiles(review, runId, revision);
  useEffect(() => {
    const current = ++generation.current;
    setReview(undefined);
    if (uncertain) { setBusy(false); setError("The decision could not be confirmed. Refresh and inspect the saved decisions before continuing. It will not be sent again automatically."); return; }
    setBusy(true); setError("");
    void window.zhivex.review(hostId, sessionId, runId).then(next => {
      if (current === generation.current) setReview(next);
    }).catch(() => {
      if (current === generation.current) setError("The review could not be loaded. Retry to see the exact changes.");
    }).finally(() => { if (current === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [hostId, sessionId, runId, revision, reload, uncertain]);
  async function decide(approve: boolean) {
    if (uncertain || !review || lock.current || (approve && (!review.canApprove || !viewed.allViewed)) || review.revision !== revision) return;
    lock.current = true; setBusy(true); setError(""); const current = generation.current, ticket = review.ticketId;
    setReview(undefined);
    try { const result = await window.zhivex.decide(hostId, ticket, approve); if (!result.ok) throw new Error(result.error.code); if (current === generation.current) onDecision(); }
    catch {
      try {
        const result = await window.zhivex.command(hostId, {method: 'run.get', sessionId, runId});
        if (result.ok && result.data.kind === 'run' && decisionRecorded(review, result.data.run, approve)) {
          if (current === generation.current) onDecision();
          return;
        }
      } catch { /* Keep the outcome uncertain; never replay a decision. */ }
      if (current === generation.current) {
        setUncertain(true); onUncertain();
        setError("The decision could not be confirmed. Refresh and inspect the saved decisions before continuing. It will not be sent again automatically.");
      }
    }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="u-review panel" aria-label="Action review">
    <div className="panel-head"><h2>Review this action</h2><span className="badge">Your approval is required</span></div>
    <div className="panel-content">
      <p>Review the exact changes and their effects before you decide.</p>
      {!review ? busy ? <p role="status">Loading action review…</p> : uncertain ? <button onClick={onRefresh}>Refresh conversation</button> : <button data-action="review" onClick={() => setReload(value => value + 1)}>Retry loading review</button> : <>
        <p>{reviewScopeSummary(review.items.length, viewed.paths.length, viewed.commands)}</p>
        {review.items.map(item => <article key={item.approvalId} className="review-item"><h3>{item.calendarChange ? "Change calendar event" : item.calendarCreation ? "Create calendar event" : actionLabel(item.name)}</h3><p>{item.consequence}</p>
          {!item.complete ? <p role="alert">This preview is incomplete ({item.restriction}). Approval is unavailable.</p> : null}
          {item.calendarChange ? <CalendarReview change={item.calendarChange} /> : null}
          {item.calendarCreation ? <CalendarReview change={item.calendarCreation} /> : null}
          {item.files.map((file, index) => <div className="review-file" key={`${file.path}:${index}`}><div className="row between"><strong>{file.path}</strong>
            <label><input type="checkbox" checked={viewed.isViewed(file.path)} onChange={event => viewed.setViewed(file.path, event.target.checked)} /> Viewed</label></div>
            <FileDiff before={file.before} after={file.after} />
          </div>)}
          {item.commands.map((command, index) => <pre key={index}>{command}</pre>)}
          <details open={item.files.length === 0 && !item.calendarChange && !item.calendarCreation}><summary>Full arguments and scope</summary><p>Action: {item.name}</p><pre>{item.payload}</pre><p>Expires {new Date(item.expiresAt).toLocaleString("en-US")}</p></details>
        </article>)}
        <div className="review-decision">
        <p className="muted">{reviewConsequence}</p>
        <p role="status">{viewed.paths.length ? viewed.viewedLabel + '. ' : ''}{!review.canApprove ? 'Approval is unavailable because the full action cannot be reviewed.' : review.revision !== revision ? 'The action changed. Wait for the updated review.' : !viewed.allViewed ? 'Review each file and mark it Viewed to enable approval.' : 'Ready for your decision.'}</p>
        <div className="row"><button className="secondary" disabled={busy || review.revision !== revision} onKeyDown={preventDecisionEnter} onClick={() => void decide(false)}>Reject</button>
          <button data-action="approve-review" disabled={busy || review.revision !== revision || !review.canApprove || !viewed.allViewed} onKeyDown={preventDecisionEnter} onClick={() => void decide(true)}>Approve this action</button></div></div>
      </>}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </section>;
}
