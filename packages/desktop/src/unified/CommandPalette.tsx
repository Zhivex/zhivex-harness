import {useEffect, useRef, useState} from 'react';
import {Button, ShellDialog} from './ui.js';
import {ArrowUpRight, MessageSquare, Search, X} from 'lucide-react';
export interface PaletteItem {id: string; label: string; group: string; run(): void}
export function CommandPalette({items, onClose}: {items: PaletteItem[]; onClose(): void}) {
  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(''), [index, setIndex] = useState(0);
  const results = items.filter(item => `${item.label} ${item.group}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = Math.min(index, Math.max(0, results.length - 1));
  useEffect(() => {body.current?.querySelector('.highlighted')?.scrollIntoView({block: 'nearest'});}, [selected, query]);
  const choose = (item?: PaletteItem) => {if (item) {onClose(); item.run();}};
  return <ShellDialog className="command-palette" labelledBy="palette-title" onClose={onClose} initialFocus="input">

    <div ref={body} className="palette-body"><header><h2 id="palette-title">Go to…</h2><Button variant="ghost" onClick={onClose} aria-label="Close search"><X size={18}/></Button></header>
      <label className="palette-search"><Search size={18}/><span className="sr-only">Search pages and conversations</span><input value={query} placeholder="Find a page or conversation…" aria-controls="palette-results" onChange={event => {setQuery(event.target.value); setIndex(0);}} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault(); setIndex(value => results.length ? (Math.min(value, results.length - 1) + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length : 0);}
        if (event.key === 'Enter') {event.preventDefault(); choose(results[selected]);}
      }}/></label>
      <p className="sr-only" role="status">{results.length} results{results[selected] ? `. Selected: ${results[selected].label}` : ''}</p>
      <ul id="palette-results" className="palette-results">{results.map((item, resultIndex) => <li key={item.id}><Button className={selected === resultIndex ? 'highlighted' : ''} onFocus={() => setIndex(resultIndex)} onClick={() => choose(item)}>{item.group === 'Conversations' ? <MessageSquare size={16}/> : <ArrowUpRight size={16}/>}<span>{item.label}<small>{item.group}</small></span></Button></li>)}</ul>
      {!results.length ? <p className="palette-empty">No matching pages or conversations.</p> : null}
      <footer>↑ ↓ to choose · Enter to open · Escape to close</footer>
    </div>
  </ShellDialog>;
}
