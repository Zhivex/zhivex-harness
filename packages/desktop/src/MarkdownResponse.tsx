import { memo, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import { externalUrl } from "./external-url.js";

function CodeBlock({ children }: ComponentProps<"pre">) {
  const content = useRef<HTMLPreElement>(null);
  const [status, setStatus] = useState("");
  return (
    <div className="code-block">
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void window.harness.copyText(content.current?.textContent ?? "").then(
            () => setStatus("Copied"),
            () => setStatus("Could not copy"),
          );
        }}
      >
        Copy code
      </button>
      <span role="status">{status}</span>
      <pre ref={content}>{children}</pre>
    </div>
  );
}
function ExternalLink({ href, children }: ComponentProps<"a">) {
  const [failed, setFailed] = useState(false);
  const url = externalUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <>
      <a
        href={url}
        title={`Open in browser: ${url}`}
        onClick={(event) => {
          event.preventDefault();
          void window.harness.openExternal(url).catch(() => setFailed(true));
        }}
      >
        {children}
      </a>
      {failed ? <span role="status"> Could not open link.</span> : null}
    </>
  );
}
const components: Components = {
  pre: CodeBlock,
  a: ExternalLink,
  img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
};
export const MarkdownResponse = memo(function MarkdownResponse({
  text,
}: {
  text: string;
}) {
  return (
    <div className="markdown-response" aria-label="Service response">
      <Markdown
        components={components}
        urlTransform={(url) => externalUrl(url) ?? ""}
      >
        {text}
      </Markdown>
    </div>
  );
});
