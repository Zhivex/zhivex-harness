import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useViewedFiles } from "../../../desktop/src/review-ui.js";

function Fixture() {
  const [runId, setRunId] = useState("run-a");
  const [revision, setRevision] = useState(1);
  const [ticketId, setTicketId] = useState(1);
  const [commandsOnly, setCommandsOnly] = useState(false);
  const [decisions, setDecisions] = useState(0);
  const viewed = useViewedFiles({
    runId, revision, ticketId: String(ticketId),
    items: [
      { files: commandsOnly ? [] : [{ path: "a.ts" }, { path: "b.ts" }], commands: ["bun test"] },
      { files: commandsOnly ? [] : [{ path: "a.ts" }], commands: [] },
    ],
  }, runId, revision);
  return <>
    <button onClick={() => setRunId(value => value === "run-a" ? "run-b" : "run-a")}>Change run</button>
    <button onClick={() => setRevision(value => value + 1)}>Change revision</button>
    <button onClick={() => setTicketId(value => value + 1)}>Change ticket</button>
    <button onClick={() => { setCommandsOnly(true); setTicketId(value => value + 1); }}>Commands only</button>
    {viewed.paths.map(path => <label key={path}>
      <input type="checkbox" checked={viewed.isViewed(path)} onChange={event => viewed.setViewed(path, event.target.checked)} />Viewed {path}
    </label>)}
    <p role="status">{viewed.count} of {viewed.paths.length} files viewed</p>
    <button disabled={!viewed.allViewed} onClick={() => { if (viewed.allViewed) setDecisions(value => value + 1); }}>{viewed.approveLabel}</button>
    <button onClick={() => setDecisions(value => value + 1)}>Reject</button>
    <output aria-label="Decisions">{decisions}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
