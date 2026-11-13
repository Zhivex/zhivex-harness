/** Render citation links only; model output is never interpreted as HTML. */
export function RunOutput({ text, onFile }: { text: string; onFile?: (path: string, line: number) => void }) {
  const parts = text.split(/(\[[^\]\n]+\]\([^\s)]+\))/g);
  return <p className="run-output">{parts.map((part, index) => {
    const match = /^\[([^\]\n]+)\]\(([^\s)]+)\)$/.exec(part);
    if (!match) return part;
    if (onFile && !/^(?:[a-z]+:|\/)/i.test(match[2]!)) {
      const file = /^(.*?)(?:#L(\d+)|:(\d+))?$/.exec(match[2]!);
      if (file && file[1] && !file[1].split('/').includes('..')) return <button className="file-link" key={index} onClick={() => onFile(file[1]!, Number(file[2] ?? file[3] ?? 1))}>{match[1]}</button>;
    }
    try {
      const url = new URL(match[2]!);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return part;
      return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer">{match[1]}</a>;
    } catch { return part; }
  })}</p>;
}
