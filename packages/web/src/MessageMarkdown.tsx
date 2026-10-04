import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Match Chat's Markdown presentation without raw HTML or remote image fetches. */
export function MessageMarkdown({ text }: { text: string }) {
  return <div className="message-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({children, href}) => href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
      img: ({alt}) => <span>[Image: {alt || "external image"}]</span>,
    }}>{text}</ReactMarkdown>
  </div>;
}
