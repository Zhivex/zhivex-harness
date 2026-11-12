/** Keep provider citations in durable text, without trusting remote HTML or URL schemes. */
export function citeResponseText(text: string, response: unknown): string {
  const output = (response as { output?: unknown[] } | undefined)?.output;
  if (!Array.isArray(output)) return text;
  for (const raw of output) {
    const item = raw as { type?: string; content?: unknown[] };
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const value of item.content) {
      const part = value as { type?: string; text?: string; annotations?: unknown[] };
      if (part?.type !== 'output_text' || part.text !== text || !Array.isArray(part.annotations)) continue;
      const citations: { start: number; end: number; link: string }[] = [];
      for (const raw of part.annotations) {
        const a = raw as { type?: string; start_index?: number; end_index?: number; url?: string; title?: string };
        if (a?.type !== 'url_citation' || !Number.isInteger(a.start_index) || !Number.isInteger(a.end_index) || typeof a.url !== 'string') continue;
        const start = a.start_index!, end = a.end_index!;
        if (start < 0 || end < start || end > text.length) continue;
        try {
          const url = new URL(a.url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
          const label = (typeof a.title === 'string' ? a.title : url.hostname).replace(/[\[\]\\\r\n]/g, ' ').slice(0, 200) || url.hostname;
          citations.push({ start, end, link: `[${label}](${url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})` });
        } catch { /* Ignore malformed remote citations. */ }
      }
      let cursor = 0, result = '';
      for (const citation of citations.sort((a, b) => a.start - b.start)) {
        if (citation.start < cursor) continue;
        result += text.slice(cursor, citation.start) + citation.link; cursor = citation.end;
      }
      return result + text.slice(cursor);
    }
  }
  return text;
}
