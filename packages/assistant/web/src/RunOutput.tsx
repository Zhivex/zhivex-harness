/** Render citation links only; model output is never interpreted as HTML. */
export function RunOutput({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g);
  return <p className="run-output">{parts.map((part, index) => {
    const match = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (!match) return part;
    try {
      const url = new URL(match[2]!);
      if (url.username || url.password) return part;
      return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer">{match[1]}</a>;
    } catch { return part; }
  })}</p>;
}
