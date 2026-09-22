import { DecisionHistory } from "./DecisionHistory.js";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ConversationActivity } from "./activity.js";
export function Conversation({
  activity,
  projectKey,
  sessionId,
}: {
  activity: ConversationActivity;
  projectKey?: string | undefined;
  sessionId?: string | undefined;
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
        return (
          <article key={id} data-run={id}>
            {run.prompt ? (
              <div className="user-message">
                <span className="eyebrow">YOU</span>
                <p>{run.prompt}</p>
              </div>
            ) : null}
            <div className="assistant-message">
              <span className="eyebrow">HARNESS</span>
              {run.text ? (
                <pre aria-label="Service response">{run.text}</pre>
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
                        {tool.name === "run_check" ? "Check" : "Tool"} ·{" "}
                        {tool.name}
                      </span>
                      <span>
                        {tool.name === "run_check" &&
                        tool.exitCode === undefined
                          ? tool.status === "running"
                            ? "Running"
                            : "No result evidence"
                          : tool.status === "running"
                            ? "Running"
                            : tool.status === "failed"
                              ? "Failed"
                              : "Completed"}
                        {tool.exitCode !== undefined
                          ? ` · exit ${tool.exitCode}`
                          : ""}
                        {tool.timedOut ? " · timed out" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="status">Status: {run.status}</p>
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
