import { useEffect, useRef, useState } from 'react';

export function SearchSelect({
  value,
  options,
  onSelect,
  ariaLabel,
  placeholder = 'Search…',
}: {
  value: string;
  options: string[];
  onSelect: (option: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);

  const filtered = options.filter((o) => o.toLowerCase().includes(query.toLowerCase()));

  const pick = (option: string) => {
    onSelect(option);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((p) => !p)}
        aria-label={ariaLabel}
        title={ariaLabel}
        className="flex max-w-56 items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-300 hover:border-zinc-600"
      >
        <span className="truncate">{value}</span>
        <span className="shrink-0 text-zinc-600">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={`${ariaLabel} search`}
            className="w-full border-b border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
            onKeyDown={(e) => {
              // Keep Escape/Enter inside the popover — the surrounding
              // modal closes on window-level Escape otherwise.
              e.stopPropagation();
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && filtered[0]) pick(filtered[0]);
            }}
          />
          <div className="max-h-64 overflow-auto py-1">
            {filtered.length === 0 && <div className="px-2 py-1 text-xs text-zinc-600">No matches</div>}
            {filtered.map((o) => (
              <button
                key={o}
                onClick={() => pick(o)}
                className={`block w-full truncate px-2 py-1 text-left text-xs ${
                  o === value ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                {o}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
