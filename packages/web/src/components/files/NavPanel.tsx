// Under the code: the places a navigation found — several definitions to pick
// from, or every reference — grouped by file. A guess from search (no language
// server answered) says so, and why. Esc closes; ↑↓ and Enter work in the list.
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { LspServerId, NavAnswer, NavHit } from '../../types';

const LANG: Record<LspServerId, string> = {
  typescript: 'TypeScript', pyright: 'Python', gopls: 'Go', 'rust-analyzer': 'Rust', clangd: 'C/C++', jdtls: 'Java',
  solargraph: 'Ruby', lua: 'Lua', zls: 'Zig', omnisharp: 'C#', texlab: 'LaTeX',
};

export type NavKind = 'definition' | 'references';

/** The panel's heading: exact answers plainly; a search guess with why it is one.
 *  `runner` names the runner when the worktree is on one: its servers are installed there. */
export function navTitle(kind: NavKind, a: NavAnswer, runner?: string): string {
  const what = kind === 'definition' ? 'definitions' : 'references';
  if (a.source === 'lsp') return kind === 'definition' ? 'Definitions' : `References · ${a.hits.length}`;
  const lang = a.server ? LANG[a.server] : 'language';
  if (a.fallback === 'starting') return `Starting ${lang}… showing search results meanwhile`;
  const why = a.fallback === 'not-installed' ? (runner ? `no ${lang} server — install it on ${runner} from a Shell tab there` : `no ${lang} server — install in Settings`)
    : a.fallback === 'disabled' ? `${lang} server is off — turn it on in Settings`
    : a.fallback === 'failed' ? `${lang} server failed — showing search results`
    : a.fallback === 'timeout' ? `${lang} server didn’t answer in time`
    : 'no language server for this file type';
  return `Possible ${what} (${why})`;
}

/** Hits grouped by file, in first-seen order. */
export function byFile(hits: NavHit[]): [string, NavHit[]][] {
  const groups = new Map<string, NavHit[]>();
  for (const h of hits) groups.set(h.path, [...(groups.get(h.path) ?? []), h]);
  return [...groups.entries()];
}

export function NavPanel({ title, hits, empty, pending, action, onPick, onClose }: {
  title: string;
  /** A button beside the title (Install, when no server is there). */
  action?: { label: string; run: () => void };
  hits: NavHit[];
  /** Said when there are no hits. */
  empty: string;
  /** Still asking: hits so far (if any) stay. */
  pending?: boolean;
  onPick: (hit: NavHit) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The list takes focus when it opens, so ↑↓/Enter/Esc work at once.
  useEffect(() => { box.current?.querySelector<HTMLElement>('[data-hit]')?.focus(); }, [hits]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    e.preventDefault();
  };
  return (
    <div ref={box} onKeyDown={move} role="region" aria-label={title} data-testid="nav-panel"
      className="flex max-h-56 shrink-0 flex-col border-t border-zinc-800/80">
      <div className="flex h-7 shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400" title={title}>{title}{pending ? ' …' : ''}</span>
        {action && (
          <button type="button" onClick={action.run} className="shrink-0 rounded-md border border-zinc-700 px-1.5 text-[11px] text-zinc-200 hover:bg-white/[0.06]">{action.label}</button>
        )}
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="rounded px-1 text-[11px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200">×</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
        {hits.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-zinc-500">{pending ? 'Looking…' : empty}</p>
        ) : byFile(hits).map(([file, group]) => (
          <section key={file} aria-label={file}>
            <h4 className="truncate px-2 pt-1 font-mono text-[11px] text-zinc-300">{file} <span className="text-zinc-600">· {group.length}</span></h4>
            <ul>
              {group.map((h) => (
                <li key={`${h.line}:${h.col}`}>
                  <button type="button" data-hit onClick={() => onPick(h)}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-0.5 text-left outline-none hover:bg-white/[0.05] focus-visible:bg-white/[0.07] focus-visible:ring-1 focus-visible:ring-sky-400/50">
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-500">{h.line}</span>
                    <span className="truncate font-mono text-[11px] text-zinc-300">{h.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
