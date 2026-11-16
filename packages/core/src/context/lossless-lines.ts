/** A reversible representation of adjacent lines sharing a long suffix.
 * Every prefix, suffix, blank line and newline is preserved. No model or
 * relevance heuristic selects which facts survive. Unsuitable text stays raw. */
export interface LosslessLines {
  encoding: 'line-suffix-v1';
  reconstruction: 'Each string is one line. For each object concatenate each prefix with suffix to obtain its lines. Join all lines with LF; do not add a final LF.';
  lines: Array<string | { prefixes: string[]; suffix: string }>;
}
const suffix = (a: string, b: string) => {
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) count++;
  // Do not split a UTF-16 surrogate pair across encoded pieces.
  if (count && /[\uDC00-\uDFFF]/.test(a[a.length - count]!)) count--;
  return count ? a.slice(-count) : '';
};
export function encodeLosslessLines(content: string): LosslessLines | undefined {
  const lines = content.split('\n');
  const encoded: LosslessLines = { encoding: 'line-suffix-v1',
    reconstruction: 'Each string is one line. For each object concatenate each prefix with suffix to obtain its lines. Join all lines with LF; do not add a final LF.', lines: [] };
  for (let start = 0; start < lines.length;) {
    let end = start + 1;
    let common = end < lines.length ? suffix(lines[start]!, lines[end]!) : '';
    if (common.length >= 48) {
      end++;
      while (end < lines.length) {
        const next = suffix(common, lines[end]!);
        if (next.length < 48) break;
        common = next; end++;
      }
    }
    const group = { prefixes: lines.slice(start, end).map(line => line.slice(0, line.length - common.length)), suffix: common };
    if (common.length >= 48 && JSON.stringify(group).length < JSON.stringify(lines.slice(start, end)).length)
      encoded.lines.push(group);
    else encoded.lines.push(...lines.slice(start, end));
    start = end;
  }
  return JSON.stringify(encoded).length < JSON.stringify(content).length * 0.7 ? encoded : undefined;
}
export const decodeLosslessLines = (encoded: LosslessLines): string => encoded.lines.flatMap(line =>
  typeof line === 'string' ? [line] : line.prefixes.map(prefix => prefix + line.suffix)).join('\n');
