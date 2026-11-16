import type { HarnessClientRun } from "@zhivex-ai/harness/protocol";
import { actionLabel, actionStatus, failureHint } from "./conversation-feedback.js";
import { MarkdownResponse } from "./MarkdownResponse.js";
import { DecisionHistory } from "./DecisionHistory.js";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ConversationActivity } from "./activity.js";
export function Conversation({
  activity,
  currentRun,
  focusRunId,
  onHistory,
  onRefresh,
  projectKey,
  sessionId,
  assistantLabel = "HARNESS",
}: {
  activity: ConversationActivity;
  currentRun?: HarnessClientRun | undefined;
  focusRunId?: string | undefined;
  onHistory?(runId: string): void;
  onRefresh?(): void;
  projectKey?: string | undefined;
  sessionId?: string | undefined;
  assistantLabel?: string;
}) {
  const root = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  useEffect(() => {
    const container = root.current?.parentElement;
    if (!container) return;
    const scroll = () => {
      follow.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        80;
    };
    container.addEventListener("scroll", scroll, { passive: true });
    return () => container.removeEventListener("scroll", scroll);
  }, []);
  useEffect(() => {
    if (!focusRunId) return;
    const turn = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-run]") ?? []).find(element => element.dataset.run === focusRunId);
    if (turn) {follow.current = false; turn.scrollIntoView({block: "start"}); turn.focus({preventScroll: true});}
  }, [focusRunId, activity.order.length]);
  useLayoutEffect(() => {
    const container = root.current?.parentElement;
    if (container) {
      if (!activity.order.length) container.scrollTop = 0;
      else if (follow.current) container.scrollTop = container.scrollHeight;
    }
  }, [activity.cursor]);
  return (
    <div
      ref={root}
      className="timeline"
      aria-label="Conversation activity"
    >
      {activity.recovered ? (
        <p className="muted">
          Activity recovered from the saved snapshot.
        </p>
      ) : null}
      {activity.order.map((id) => {
        const run = activity.runs[id]!;
        const saved = currentRun?.runId === id ? currentRun : undefined;
        const status = saved?.status ?? run.status;
        return (
          <article key={id} data-run={id} tabIndex={-1}>
            {run.prompt ? (
              <div className="user-message">
                <span className="eyebrow">YOU</span>
                <p>{run.prompt}</p>
              </div>
            ) : null}
            <div className="assistant-message">
              <span className="eyebrow">{assistantLabel}</span>
              {run.text ? (
                <MarkdownResponse text={run.text} />
              ) : null}
              {run.tools ? (
                <ul
                  className="tool-activity"
                  aria-label="Tools and checks"
                >
                  {Object.entries(run.tools).map(([key, tool]) => (
                    <li
                      key={key}
                      data-tool={tool.name}
                      data-tool-status={tool.status}
                    >
                      <span>
                        {actionLabel(tool.name)}
                      </span>
                      <span>
                        {actionStatus(tool, status, saved?.decisions?.find(decision => `tool:${decision.toolCallId}` === key))}
                        {tool.exitCode !== undefined
                          ? ` · exit ${tool.exitCode}`
                          : ""}
                        {tool.timedOut ? " · timed out" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="status" role="status">{status === 'running' ? run.text ? 'Responding…' : 'Waiting for the first response…' : status === 'completed' ? 'Response complete' : status === 'waiting_approval' ? 'Waiting for your review' : status === 'failed' ? 'The response could not be completed. Your message is saved.' : status === 'cancelled' ? 'Response stopped' : `Status: ${run.status}`}</p>
              {status === 'failed' ? <div className="conversation-failure" role="alert"><p>{failureHint(saved?.error)}</p><p className="muted">Your message is saved. Nothing will be retried automatically.</p><div className="row">{onHistory ? <button className="secondary" onClick={() => onHistory(id)}>View saved decisions</button> : null}{onRefresh ? <button className="secondary" onClick={onRefresh}>Refresh conversation</button> : null}</div>{saved?.error ? <details><summary>Error details</summary><code>{saved.error.code}</code></details> : null}</div> : null}
              {status !== "failed" && onHistory ? <button className="secondary" onClick={() => onHistory(id)}>Decisions for this turn</button> : null}
              {run.truncated ? (
                <p className="muted">Content limited by retention.</p>
              ) : null}
            </div>
            {projectKey && sessionId ? (
              <DecisionHistory
                key={`${projectKey}:${sessionId}:${id}`}
                projectKey={projectKey}
                sessionId={sessionId}
                runId={id}
              />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
