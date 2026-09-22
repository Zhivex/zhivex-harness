import { useMemo, useRef, useState } from "react";
import { diffLines } from "diff";

export function FileDiff({
  before,
  after,
}: {
  before: string | undefined;
  after: string | undefined;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(-1);
  const parts = useMemo(
    () =>
      diffLines(before ?? "", after ?? "", {
        timeout: 50,
        maxEditLength: 4000,
      }),
    [before, after],
  );
  if (!parts)
    return (
      <div>
        <p>Large change: showing complete contents.</p>
        <details>
          <summary>Before</summary>
          <pre className="removed">{before ?? "File missing"}</pre>
        </details>
        <details>
          <summary>After</summary>
          <pre className="added">{after ?? "File deleted"}</pre>
        </details>
      </div>
    );
  const changes = parts.filter((part) => part.added || part.removed).length;
  let oldLine = 1,
    newLine = 1;
  return (
    <div className="file-diff" ref={root}>
      <div className="diff-toolbar">
        <span>
          +{parts.reduce((n, p) => n + (p.added ? p.count : 0), 0)} / −
          {parts.reduce((n, p) => n + (p.removed ? p.count : 0), 0)} lines
        </span>
        <button
          type="button"
          className="secondary"
          disabled={!changes}
          onClick={() => {
            const next = (index + 1) % changes;
            setIndex(next);
            const block =
              root.current?.querySelectorAll<HTMLElement>("[data-diff-change]")[
                next
              ];
            block?.scrollIntoView({ block: "nearest" });
            block?.focus({ preventScroll: true });
          }}
        >
          Next change
        </button>
      </div>
      <div
        className="diff-lines"
        role="region"
        aria-label="Unified diff"
        tabIndex={0}
      >
        {parts.map((part, i) => (
          <div
            key={i}
            data-diff-change={part.added || part.removed ? "" : undefined}
            tabIndex={part.added || part.removed ? -1 : undefined}
            className={
              part.added ? "diff-added" : part.removed ? "diff-removed" : ""
            }
          >
            {part.value
              .replace(/\n$/, "")
              .split("\n")
              .map((line, j) => (
                <div className="diff-line" key={j}>
                  <span className="line-number">
                    {part.added ? "" : oldLine++}
                  </span>
                  <span className="line-number">
                    {part.removed ? "" : newLine++}
                  </span>
                  <span>{part.added ? "+" : part.removed ? "−" : " "}</span>
                  <code>{line || " "}</code>
                </div>
              ))}
            {!part.value.endsWith("\n") ? (
              <div className="muted">\ No newline at end of file</div>
            ) : null}
          </div>
        ))}
      </div>
      <details>
        <summary>Complete contents · before and after</summary>
        <p>Before</p>
        <pre className="removed">{before ?? "File missing"}</pre>
        <p>After</p>
        <pre className="added">{after ?? "File deleted"}</pre>
      </details>
    </div>
  );
}
