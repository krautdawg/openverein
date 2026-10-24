import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { matches, searchProviders, type Command } from '../lib/commands.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  go: (path: string) => void;
}

/** Ctrl/Cmd+K: jump anywhere and run any action without leaving the keyboard. */
export function CommandPalette({ open, onClose, commands, go }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<Command[]>([]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2 || searchProviders.length === 0) {
      setRemote([]);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      const results = (await Promise.all(searchProviders.map((p) => p(query.trim(), go).catch(() => [])))).flat();
      if (!stale) setRemote(results);
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, open, go]);

  const results = useMemo(() => [...commands.filter((c) => matches(c, query)), ...remote], [commands, query, remote]);
  const current = Math.min(active, Math.max(0, results.length - 1));

  function run(c: Command | undefined) {
    if (!c) return;
    onClose();
    c.run();
  }

  return (
    <dialog ref={ref} className="palette" aria-label="Befehle und Suche" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results[current] ? `cmd-${results[current].id}` : undefined}
        placeholder="Wohin? Was tun? Name suchen …"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); run(results[current]); }
        }}
      />
      <ul id="palette-list" role="listbox">
        {results.map((c, i) => (
          <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === current} onMouseMove={() => setActive(i)} onClick={() => run(c)}>
            {c.icon && <c.icon size={16} aria-hidden />}
            <span>{c.label}</span>
            {c.hint && <span className="meta">{c.hint}</span>}
          </li>
        ))}
        {results.length === 0 && <li className="empty" role="presentation">Nichts gefunden für „{query}“.</li>}
      </ul>
      <div className="palette-foot">
        <span><kbd>↑</kbd> <kbd>↓</kbd> auswählen</span>
        <span><CornerDownLeft size={12} aria-hidden /> ausführen</span>
        <span><kbd>Esc</kbd> schließen</span>
      </div>
    </dialog>
  );
}
