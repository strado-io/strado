import { useRef, useState } from 'react';
import type React from 'react';
import { PlusIcon } from './icons';
import { tabKeyOf } from '../../hooks/tabOrder';
import type { NamedSessionMode } from '../../hooks/shellNames';
import { stateWord } from '../../lib/dock/stations';
import { BREATHE, TAB_TONE, urgentState, type TabAgentState } from './agentTone';
import { TabTile, TileStack, groupTitle } from './TabTile';

export { TabTile };

/** A hub tab, as the strip needs it (TerminalView's Tab). */
export type StripTab = { path: string; mode: string; id: string; remote?: { runnerId: string } | null };
export type StripEntry<T extends StripTab> = { tab: T; label: string; icon: React.ReactNode; hint?: string };
export type TabRename = { path: string; mode: NamedSessionMode; id: string; value: string };

const RENAMABLE = new Set(['shell', 'claude', 'codex', 'opencode', 'pi']);
/** Tabs with an agent (or a shell) behind them: they can be messaged from the box. */
/** A split layout drawn as one segment. `name` null: the members' labels, joined. */
export type TabGroup = { layoutIndex: number; keys: string[]; name: string | null; active: boolean };
// Dim secondary text ends in a fade, not an ellipsis.
const FADE = '[mask-image:linear-gradient(to_right,black_70%,transparent)]';

/** The worktree hub's tab strip: one segment per tab (a split layout as one
 * segment when `groups` is given), drag to reorder or split, double-click to
 * rename, + for a new session, then the Focus's other worktrees' agents. A tab
 * wears its agent's state. TerminalView owns every piece of state; this only
 * draws it. */
export function TabStrip<T extends StripTab>({
  tabs, isActive, splitGroups, renaming, onRenaming, onRename, tabEl, pointer, justDraggedRef, onActivate, onClose, onAdd, detail,
  stateOf, groups, onActivateGroup, onCloseGroup, onRenameGroup,
}: {
  tabs: StripEntry<T>[];
  isActive: (tab: T) => boolean;
  /** Each split layout's member keys, in strip order. */
  splitGroups: { layoutIndex: number; keys: string[] }[];
  renaming: TabRename | null;
  onRenaming: (r: TabRename | null) => void;
  onRename: (r: TabRename) => void;
  /** The strip's elements by tab key (drag hit-testing). */
  tabEl: (key: string, el: HTMLElement | null) => void;
  pointer: {
    down: (e: React.PointerEvent<HTMLElement>, key: string) => void;
    move: (e: React.PointerEvent<HTMLElement>) => void;
    up: (e: React.PointerEvent<HTMLElement>) => void;
    cancel: () => void;
  };
  justDraggedRef: React.MutableRefObject<boolean>;
  onActivate: (tab: T) => void;
  onClose: (tab: T) => void;
  /** The + button: opens the new-session menu under it. */
  onAdd: (anchor: DOMRect) => void;
  /** Dim text after the title (the branch, a run's name); null for none. */
  detail?: (tab: T) => string | null;
  /** The state of the agent behind a tab (from its station); null for none. */
  stateOf?: (tab: T) => TabAgentState | null;
  /** Split layouts drawn as one segment each (at their first member's place). */
  groups?: TabGroup[];
  onActivateGroup?: (layoutIndex: number) => void;
  onCloseGroup?: (layoutIndex: number) => void;
  /** '' clears the name (null). */
  onRenameGroup?: (layoutIndex: number, name: string | null) => void;
}) {
  const [renamingGroup, setRenamingGroup] = useState<{ index: number; value: string } | null>(null);
  const groupOf = (key: string) => splitGroups.find((group) => group.keys.includes(key));
  // A tab that just opened slides in. Only one added beside tabs already here:
  // switching worktrees swaps the whole set, and that shouldn't animate.
  const prevKeys = useRef<Set<string> | null>(null);
  const keys = new Set(tabs.map((e) => tabKeyOf(e.tab)));
  const prev = prevKeys.current;
  const entering = prev && [...prev].some((k) => keys.has(k)) ? new Set([...keys].filter((k) => !prev.has(k))) : new Set<string>();
  prevKeys.current = keys;
  const animated = useRef(new Set<string>());
  const enterRef = (key: string, el: HTMLElement | null) => {
    if (!el || !entering.has(key) || animated.current.has(key)) return;
    animated.current.add(key);
    animateTabIn(el);
  };
  const byKey = new Map(tabs.map((e) => [tabKeyOf(e.tab), e]));
  // One item per tab, except a drawn group's members: the group, once, where its first member was.
  type Item = { kind: 'tab'; entry: StripEntry<T> } | { kind: 'group'; group: TabGroup; members: StripEntry<T>[] };
  const items: Item[] = [];
  const placed = new Set<number>();
  for (const entry of tabs) {
    const g = groups?.find((x) => x.keys.includes(tabKeyOf(entry.tab)));
    if (!g) { items.push({ kind: 'tab', entry }); continue; }
    if (placed.has(g.layoutIndex)) continue;
    placed.add(g.layoutIndex);
    items.push({ kind: 'group', group: g, members: g.keys.map((k) => byKey.get(k)).filter((e): e is StripEntry<T> => !!e) });
  }
  // Quiet when idle; tinted (and breathing) while it works or wants you. A tint outranks the pill's own colour.
  const tone = (state: TabAgentState | null) => (state ? `${TAB_TONE[state] ?? ''} ${BREATHE[state] ?? ''}` : '');
  const surface = (active: boolean, state: TabAgentState | null) =>
    `${active ? 'z-[1] tab-pill' : 'border border-transparent hover:bg-white/[0.04]'} ${tone(state)}`;
  // A small button that shows on hover/focus (and on the active segment), taking no room while hidden.
  // Literal classes: Tailwind only generates what it can read in the source.
  // The ✕ always holds its room and only fades in: growing it on hover widened
  // the tab and shoved the ones after it, so the cursor slipped off and the
  // hover flickered on and off.
  const reveal = (shown: boolean) =>
    shown ? 'w-5' : 'w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100';
  const closeBtn = 'flex h-5 shrink-0 items-center justify-center overflow-hidden rounded-md text-[11px] text-zinc-500 hover:bg-white/10 hover:text-red-300';

  const tabSegment = ({ tab, label: tabLabel, icon, hint }: StripEntry<T>) => {
    const active = isActive(tab);
    const renamable = RENAMABLE.has(tab.mode);
    const isRenaming =
      renamable && renaming?.path === tab.path && renaming?.mode === tab.mode && renaming?.id === tab.id;
    const commitRename = () => {
      if (!renaming) return;
      onRename(renaming);
      onRenaming(null);
    };
    const tKey = tabKeyOf(tab);
    const splitGroup = groupOf(tKey);
    const isInSplit = !!splitGroup;
    const state = stateOf?.(tab) ?? null;
    const sub = detail?.(tab) ?? null;
    const tile = <TabTile mode={tab.mode} icon={icon} />;
    return (
      <span
        data-tab-key={tKey}
        data-active={active || undefined}
        data-in-split={isInSplit || undefined}
        data-split-group={splitGroup?.layoutIndex}
        data-agent-state={state ?? undefined}
        ref={(el) => { tabEl(tKey, el); enterRef(tKey, el); }}
        onPointerDown={(e) => { if (!isRenaming) pointer.down(e, tKey); }}
        onPointerMove={pointer.move}
        onPointerUp={pointer.up}
        onPointerCancel={pointer.cancel}
        onClickCapture={(e) => {
          // a completed drag must not also activate the tab
          if (justDraggedRef.current) {
            justDraggedRef.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        // Single and group tabs share one look; only the icon differs (one tile, or a deck).
        className={`group flex h-full max-w-[18rem] shrink-0 select-none items-center rounded-[10px] pr-1.5 text-[13px] transition-colors ${surface(active, state)}`}
        style={{ touchAction: 'none' }}
      >
        {isRenaming ? (
          <span className="flex items-center gap-2 pl-1.5 pr-1">
            {tile}
            <input
              autoFocus
              value={renaming.value}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onRenaming({ ...renaming, value: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => {
                e.stopPropagation(); // typing must not trigger tab hotkeys
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') onRenaming(null);
              }}
              aria-label="Rename tab"
              className="w-28 rounded border border-zinc-700 bg-zinc-950 px-1 py-0 text-xs text-zinc-100 outline-none focus:border-zinc-500"
            />
          </span>
        ) : (
          <button
            onClick={() => onActivate(tab)}
            onDoubleClick={
              renamable
                ? () => onRenaming({ path: tab.path, mode: tab.mode as NamedSessionMode, id: tab.id, value: tabLabel })
                : undefined
            }
            // The state in words too: the tint is never the only signal.
            title={[state && state !== 'idle' ? `${tabLabel} ${stateWord(state)}` : null, hint, renamable ? 'Double-click to rename' : null].filter(Boolean).join(' · ') || undefined}
            className="flex h-full min-w-0 items-center gap-2 pl-1.5 pr-1"
          >
            {tile}
            <span data-testid="tab-title" className={`shrink-0 font-medium ${active ? 'text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-200'}`}>{tabLabel}</span>
            {sub && <span data-testid="tab-detail" className={`min-w-0 max-w-[10rem] truncate text-zinc-500 ${FADE}`}>{sub}</span>}
          </button>
        )}
        <button
          data-tab-close
          onClick={() => onClose(tab)}
          title={`Close ${tabLabel} session`}
          aria-label={`Close ${tabLabel} session`}
          // Hidden on a flat tab takes no room either (no gap before the divider).
          className={`${closeBtn} ${reveal(active)}`}
        >
          ✕
        </button>
      </span>
    );
  };

  const groupSegment = (group: TabGroup, members: StripEntry<T>[]) => {
    const title = groupTitle(group.name, members.map((m) => m.label));
    const state = stateOf ? urgentState(members.map((m) => stateOf(m.tab))) : null;
    const editing = renamingGroup?.index === group.layoutIndex ? renamingGroup : null;
    const commit = () => {
      if (!editing) return;
      onRenameGroup?.(group.layoutIndex, editing.value.trim() || null);
      setRenamingGroup(null);
    };
    return (
      <span
        data-testid="tab-group"
        data-group-index={group.layoutIndex}
        data-active={group.active || undefined}
        data-agent-state={state ?? undefined}
        className={`group flex h-full max-w-[18rem] shrink-0 select-none items-center rounded-[10px] pr-1.5 text-[13px] transition-colors ${surface(group.active, state)}`}
      >
        {/* Its members' tiles, overlapping. */}
        <span className="flex shrink-0 items-center pl-1.5">
          <TileStack tiles={members.map((m) => ({ key: tabKeyOf(m.tab), mode: m.tab.mode, icon: m.icon }))} />
        </span>
        {editing ? (
          <input
            autoFocus
            value={editing.value}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenamingGroup({ index: group.layoutIndex, value: e.target.value })}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation(); // typing must not trigger tab hotkeys
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') setRenamingGroup(null);
            }}
            aria-label="Rename group"
            className="ml-2 w-32 rounded border border-zinc-700 bg-zinc-950 px-1 py-0 text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
        ) : (
          <button
            type="button"
            onClick={() => onActivateGroup?.(group.layoutIndex)}
            onDoubleClick={onRenameGroup ? () => setRenamingGroup({ index: group.layoutIndex, value: group.name ?? '' }) : undefined}
            title={[state && state !== 'idle' ? stateWord(state) : null, onRenameGroup ? 'Double-click to rename' : null].filter(Boolean).join(' · ') || undefined}
            className="flex h-full min-w-0 items-center pl-2 pr-1"
          >
            <span data-testid="tab-title" className={`min-w-0 truncate font-medium ${group.active ? 'text-zinc-100' : 'text-zinc-400 group-hover:text-zinc-200'}`}>{title}</span>
          </button>
        )}
        {onCloseGroup && (
          <button
            type="button"
            onClick={() => onCloseGroup(group.layoutIndex)}
            title={`Close group ${title}`}
            aria-label={`Close group ${title}`}
            className={`${closeBtn} ${reveal(group.active)}`}
          >
            ✕
          </button>
        )}
      </span>
    );
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
      <div data-testid="tab-segments" className="tab-bar flex h-9 shrink-0 items-center rounded-[13px] p-[3px]">
        {items.map((it, i) => {
          // A light hairline between every two segments, the active pill's sides too.
          const divider = i > 0;
          const key = it.kind === 'tab' ? tabKeyOf(it.entry.tab) : `group:${it.group.layoutIndex}`;
          return (
            <span key={key} className="contents">
              {divider && <span aria-hidden="true" data-testid="tab-divider" className="tab-divider mx-1 h-4 w-px shrink-0" />}
              {it.kind === 'tab' ? tabSegment(it.entry) : groupSegment(it.group, it.members)}
            </span>
          );
        })}
      </div>
      <button
        onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())}
        title="New session"
        aria-label="New session"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A new tab grows open from nothing and fades in. */
function animateTabIn(el: HTMLElement) {
  if (typeof el.animate !== 'function' || reducedMotion()) return;
  const width = el.getBoundingClientRect().width;
  if (!width) return;
  el.animate(
    [{ maxWidth: '0px', opacity: 0, overflow: 'hidden' }, { maxWidth: `${width}px`, opacity: 1, overflow: 'hidden' }],
    { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
}

/** A closing tab shrinks to nothing and fades before it's removed, so the tabs
 * after it slide over instead of jumping. Resolves when done
 * with an undo, for a tab that turned out to stay; null when it can't animate. */
export function animateTabOut(key: string): Promise<() => void> | null {
  const el = typeof document !== 'undefined' ? document.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`) : null;
  if (!el || typeof el.animate !== 'function' || reducedMotion()) return null;
  const width = el.getBoundingClientRect().width;
  const a = el.animate(
    [{ maxWidth: `${width}px`, opacity: 1, overflow: 'hidden' }, { maxWidth: '0px', opacity: 0, paddingRight: '0px', overflow: 'hidden' }],
    { duration: 100, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
  );
  const undo = () => a.cancel();
  return a.finished.then(() => undo, () => undo);
}
