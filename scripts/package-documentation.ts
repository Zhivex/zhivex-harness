import path from "node:path";

/** Relative Markdown targets must resolve inside the published archive. Fenced
 * examples and repository-only references written as code are not hyperlinks. */
export const missingPackageLinks = (file: string, markdown: string, entries: ReadonlySet<string>) => {
  const source = markdown.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
  const missing: string[] = [];
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1]!.replace(/^<|>$/g, "");
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(raw)) continue;
    let target: string;
    try { target = decodeURIComponent(raw.split(/[?#]/)[0]!); } catch { missing.push(raw); continue; }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/\/$/, "");
    if (target.startsWith("/") || !resolved.startsWith("package/") ||
      !(entries.has(resolved) || [...entries].some(entry => entry.startsWith(`${resolved}/`)))) missing.push(raw);
  }
  return missing;
};
