import type React from 'react';
import { useEffect, useRef, useState } from 'react';

/** One kind the hub can open: the new-session (+) menu's rows. */
export type NewSessionOption = {
  mode: string;
  label: string;
  /** A monochrome line icon; each menu sets its colour. */
  icon: React.ReactNode;
  run: () => void;
  disabled?: boolean;
  hint?: string;
  badge?: string;
};

/** The one-letter shortcut per kind in a new pane. */
export const SURFACE_KEYS: Record<string, string> = {
  claude: 'C', codex: 'X', opencode: 'O', pi: 'P', shell: 'T', kb: 'K', browser: 'B', diff: 'D',
};

// What fills a new, empty split pane: "Open a surface", the + menu's kinds as
// a list. It has the keyboard as soon as it appears: a kind's letter opens it,
// ↑↓ + ↵ pick, Esc cancels (the pane goes away). A disabled kind (not
// installed) shows why and does nothing.
export function OpenSurface({ options, onPick, onCancel }: {
  options: NewSessionOption[];
  onPick: (option: NewSessionOption) => void;
  onCancel: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const [sel, setSel] = useState(enabled[0] ?? -1);
  useEffect(() => { rootRef.current?.focus(); }, []);

  const pick = (o: NewSessionOption | undefined) => { if (o && !o.disabled) onPick(o); };
  const move = (by: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(sel);
    setSel(enabled[at < 0 ? 0 : (at + by + enabled.length) % enabled.length]!);
  };

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      role="menu"
      aria-label="Open a surface"
      data-testid="open-surface"
      className="flex h-full w-full items-center justify-center overflow-auto outline-none"
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(options[sel]); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        else if (e.key.length === 1) {
          const o = options.find((x) => SURFACE_KEYS[x.mode] === e.key.toUpperCase());
          if (o) { e.preventDefault(); pick(o); }
        }
      }}
    >
      <div className="w-full max-w-xs px-4 py-6">
        <div className="mb-4 text-center text-[15px] font-medium text-zinc-100">Open a surface</div>
        {options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-label={o.label}
            data-selected={i === sel || undefined}
            disabled={o.disabled}
            aria-disabled={o.disabled || undefined}
            title={o.disabled ? o.hint : undefined}
            onMouseEnter={() => { if (!o.disabled) setSel(i); }}
            onClick={() => pick(o)}
            className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[15px] ${
              o.disabled ? 'cursor-not-allowed text-zinc-500' : `text-zinc-100 ${i === sel ? 'bg-white/[0.05]' : ''}`
            }`}
          >
            <span className={`flex w-5 shrink-0 justify-center ${o.disabled ? 'text-zinc-600' : 'text-zinc-300'}`}>{o.icon}</span>
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.disabled && <span className="text-[11px] text-zinc-600">{o.badge ?? 'install'}</span>}
            <kbd className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.06] font-sans text-[11px] ${o.disabled ? 'text-zinc-600' : 'text-zinc-400'}`}>
              {SURFACE_KEYS[o.mode] ?? ''}
            </kbd>
          </button>
        ))}
      </div>
    </div>
  );
}
