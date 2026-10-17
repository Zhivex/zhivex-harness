export interface RevealedPiece {
  text: string;
  /** The text stands in for a character a terminal or browser would hide. */
  mark: boolean;
}

const hex4 = (codePoint: number) => `\\u${codePoint.toString(16).padStart(4, "0")}`;

/** Visible replacement for one hidden code point, or undefined when the character can stay. */
const hiddenEscape = (codePoint: number): string | undefined => {
  if (codePoint === 0) return "\\0";
  if (codePoint === 0x200b) return "\\u200B";
  if (codePoint === 0x200c) return "\\u200C";
  if (codePoint === 0x200d) return "\\u200D";
  if (codePoint === 0x200e) return "\\u200E";
  if (codePoint === 0x200f) return "\\u200F";
  if (codePoint === 0xfeff) return "\\uFEFF";
  if (codePoint === 0x2060) return "\\u2060";
  if (codePoint === 0x00ad) return "\\u00AD";
  if (codePoint === 0x180e) return "\\u180E";
  if (codePoint === 0x061c) return "\\u061C";
  if (codePoint === 0x034f) return "\\u034F";
  if (codePoint >= 0x202a && codePoint <= 0x202e) return hex4(codePoint);
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return hex4(codePoint);
  if (codePoint === 0x2028 || codePoint === 0x2029) return hex4(codePoint);
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return hex4(codePoint);
  if (codePoint === 0xe0001 || (codePoint >= 0xe0020 && codePoint <= 0xe007f)) return `\\u{${codePoint.toString(16)}}`;
  return undefined;
};

/**
 * Show control, zero-width, and bidi characters, and mark tabs and trailing whitespace.
 * Newlines stay newlines so a diff line remains one row. A second pass leaves the result unchanged.
 */
export const revealInvisiblePieces = (line: string): RevealedPiece[] => {
  const pieces: RevealedPiece[] = [];
  const push = (text: string, mark: boolean) => {
    if (!text) return;
    const last = pieces.at(-1);
    if (last && last.mark === mark) last.text += text;
    else pieces.push({ text, mark });
  };
  const chars = [...line];
  let trail = chars.length;
  while (trail > 0 && (chars[trail - 1] === " " || chars[trail - 1] === "\t")) trail -= 1;
  let column = 0;
  chars.forEach((char, index) => {
    const inTrail = index >= trail;
    if (char === "\n") { push("\n", false); column = 0; return; }
    if (char === "\t") {
      if (inTrail) push("→", true);
      else {
        const width = 4 - (column % 4);
        push("→" + " ".repeat(width - 1), true);
        column += width;
      }
      return;
    }
    if (inTrail && char === " ") { push("·", true); column += 1; return; }
    const escaped = hiddenEscape(char.codePointAt(0) ?? 0);
    if (escaped) { push(escaped, true); column += escaped.length; return; }
    push(char, false);
    column += 1;
  });
  return pieces;
};

export const revealInvisible = (line: string) => revealInvisiblePieces(line).map(piece => piece.text).join("");

/** Reveal each line and keep the newline structure of a whole file. */
export const revealInvisibleText = (value: string) => value.split("\n").map(line => revealInvisible(line)).join("\n");
