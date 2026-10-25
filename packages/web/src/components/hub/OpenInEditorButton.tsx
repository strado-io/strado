import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorId, EditorStatus } from '../../types';
import { ChevronDownIcon } from './icons';

// The hub header's "Open in editor", beside Run and shaped like it: [app icon | ▾]. The icon opens with
// the chosen editor; the menu opens once with any other installed one, or
// shows the folder in Finder. Picking from the menu never changes the choice
// (that is Settings › Files).

export type OpenWith = EditorId | 'finder';

// An icon that failed to load once (no route, not macOS) isn't asked for again.
const missingIcons = new Set<string>();

export function EditorAppIcon({ id, size = 16 }: { id: EditorId; size?: number }) {
  const [failed, setFailed] = useState(missingIcons.has(id));
  if (failed) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden data-testid={`editor-glyph-${id}`}>
        {id === 'system'
          ? <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
          : <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />}
      </svg>
    );
  }
  return (
    <img
      src={`/api/editors/${encodeURIComponent(id)}/icon`}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => { missingIcons.add(id); setFailed(true); }}
      className="shrink-0"
    />
  );
}

/** For tests. */
export function resetEditorIcons(): void {
  missingIcons.clear();
}

export function OpenInEditorButton({ editors, chosen, onOpen, shortcut = '⌘O' }: {
  /** Every editor the server listed; only installed ones are offered. */
  editors: EditorStatus[];
  chosen: EditorStatus;
  onOpen: (editor: OpenWith) => void;
  shortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The server names it for the OS: Finder on macOS, File manager elsewhere.
  const finder = editors.find((e) => e.id === 'system')?.label ?? 'File manager';
  const others = editors.filter((e) => e.available && e.id !== chosen.id && e.id !== 'system');
  const items: { key: OpenWith; label: string; icon: EditorId; hint?: string }[] = [
    ...(chosen.id === 'system' ? [] : [{ key: chosen.id, label: chosen.label, icon: chosen.id, hint: shortcut }]),
    ...others.map((e) => ({ key: e.id, label: e.label, icon: e.id })),
    { key: 'finder', label: finder, icon: 'system' },
  ];
  const mainLabel = chosen.id === 'system' ? `Show in ${finder}` : `Open in ${chosen.label}`;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) caretRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !caretRef.current) return;
    const r = caretRef.current.getBoundingClientRect();
    setPos({ x: r.right, y: r.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, pos]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  };

  // RunButton's shape, so the two sit as a pair.
  const half = 'flex h-full items-center transition hover:bg-white/5 hover:text-zinc-100';
  return (
    <div className="relative flex h-7 shrink-0 self-center rounded-md border border-zinc-800 text-zinc-300 hover:border-zinc-600">
      <button type="button" aria-label={mainLabel} title={`${mainLabel} (${shortcut})`} onClick={() => onOpen(chosen.id === 'system' ? 'finder' : chosen.id)} className={`${half} rounded-l-[5px] px-2`}>
        <EditorAppIcon id={chosen.id} size={15} />
      </button>
      <span aria-hidden className="my-1 w-px bg-current opacity-20" />
      <button
        ref={caretRef}
        type="button"
        aria-label="Open with…"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Open with…"
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
        className={`${half} rounded-r-[5px] px-1 ${open ? 'bg-white/5' : ''}`}
      >
        <ChevronDownIcon size={12} />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onPointerDown={() => close(false)} />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Open with"
            onKeyDown={onMenuKey}
            className="surface-pop fixed z-50 min-w-52 -translate-x-full rounded-lg p-1"
            style={{ left: pos.x, top: pos.y }}
          >
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => { close(true); onOpen(it.key); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-200 outline-none hover:bg-zinc-800/70 focus:bg-zinc-800/70"
              >
                <EditorAppIcon id={it.icon} />
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint && <span className="text-[11px] text-zinc-500">{it.hint}</span>}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
