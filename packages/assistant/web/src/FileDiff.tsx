import { revealInvisibleText } from './reveal-invisible';
/** Desktop's complete-content fallback: exact before/after, with hidden characters revealed. */
export function FileDiff({ before, after }: { before?: string | undefined; after?: string | undefined }) {
  return <div className="workspace-diff" role="region" aria-label="Diff del archivo"><section><h5>Antes</h5><pre tabIndex={0}>{before === undefined ? 'Archivo ausente' : revealInvisibleText(before)}</pre></section><section><h5>Después</h5><pre tabIndex={0}>{after === undefined ? 'Archivo eliminado' : revealInvisibleText(after)}</pre></section></div>;
}
