import { encodeLosslessLines, decodeLosslessLines, type LosslessLines } from './lossless-lines.js';

export interface NumberedReadLines {
  encoding: 'numbered-lines-v1';
  startLine: number;
  text: string | LosslessLines;
  reconstruction: string;
}
/** Remove only the mechanically generated sequential line-number prefixes.
 * Source text, indentation, whitespace, empty lines and ordering stay exact.
 * The representation is self-contained; it needs no lookup or model summary.
 */
export function encodeNumberedReadLines(content: string): NumberedReadLines | undefined {
  const lines = content.split('\n');
  if (lines.length < 16) return undefined;
  const match = /^([1-9]\d*): /.exec(lines[0]!);
  if (!match) return undefined;
  const startLine = Number(match[1]);
  if (!Number.isSafeInteger(startLine + lines.length - 1)) return undefined;
  const raw: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prefix = `${startLine + i}: `;
    if (!lines[i]!.startsWith(prefix)) return undefined;
    raw.push(lines[i]!.slice(prefix.length));
  }
  const text = raw.join('\n');
  const encoded: NumberedReadLines = { encoding: 'numbered-lines-v1', startLine,
    text: encodeLosslessLines(text) ?? text,
    reconstruction: 'Source text is unchanged. Split text on LF; prepend (startLine + zero-based line index) followed by colon and space to each line, then join with LF to recover the original numbered read.' };
  return JSON.stringify(encoded).length + 64 < JSON.stringify(content).length ? encoded : undefined;
}
export function decodeNumberedReadLines(value: NumberedReadLines): string {
  const text = typeof value.text === 'string' ? value.text : decodeLosslessLines(value.text);
  return text.split('\n').map((line, i) => `${value.startLine + i}: ${line}`).join('\n');
}
/** Pick the smallest exact representation; raw input remains the fallback. */
export function encodeReadContent(content: string): LosslessLines | NumberedReadLines | undefined {
  const candidates = [encodeLosslessLines(content), encodeNumberedReadLines(content)]
    .filter((value): value is LosslessLines | NumberedReadLines => value !== undefined);
  return candidates.sort((a,b) => JSON.stringify(a).length - JSON.stringify(b).length)[0];
}
