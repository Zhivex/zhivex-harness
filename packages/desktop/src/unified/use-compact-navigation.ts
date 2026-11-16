import {useCallback, useEffect, useRef, useState} from 'react';

export function useCompactNavigation(open: boolean, setOpen: (open: boolean) => void) {
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 850px)').matches);
  const sidebar = useRef<HTMLElement>(null), toggle = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null), searchRequested = useRef(false);
  useEffect(() => {
    const media = matchMedia('(max-width: 850px)');
    const change = () => setCompact(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const show = useCallback((focusSearch = false) => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && !sidebar.current?.contains(active) ? active : toggle.current;
    searchRequested.current = focusSearch;
    if (open || !compact) {if (focusSearch) search.current?.focus();}
    setOpen(true);
  }, [open, compact, setOpen]);
  useEffect(() => {
    if (!compact || !open) return;
    const panel = sidebar.current;
    if (!panel) return;
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(node => node.getClientRects().length > 0 && !node.closest('[inert]'));
    if (searchRequested.current) search.current?.focus();
    else focusable()[0]?.focus();
    searchRequested.current = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); setOpen(false); return;}
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first || !last) {event.preventDefault(); panel.focus(); return;}
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {event.preventDefault(); last.focus();}
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {event.preventDefault(); first.focus();}
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const target = opener.current?.isConnected && opener.current.getClientRects().length ? opener.current : toggle.current;
      target?.focus();
    };
  }, [compact, open, setOpen]);
  return {compact, sidebar, toggle, search, show};
}
