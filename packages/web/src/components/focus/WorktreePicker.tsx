// A checklist of every worktree in the space: local ones grouped by repo,
// runner ones under their runner, with a search box over label, title,
// branch and repo. Used by the Focus composer and by "Add worktrees".
import { useState } from 'react';
import type { RemoteWorktree } from '../../api';
import type { RepoConfig, Worktree } from '../../types';
import { worktreeLabel, worktreeTitle } from '../sidebar/labels';
import { localPinId, remotePinId } from '../sidebar/pinIds';
import { RepoAvatar } from '../sidebar/WorktreeCard';

export type PickerGroup = { key: string; name: string; repoId: string | null; items: { pinId: string; label: string; detail: string; haystack: string }[] };

export function pickerGroups(repos: RepoConfig[], worktrees: Worktree[], remoteWorktrees: RemoteWorktree[]): PickerGroup[] {
  const groups: PickerGroup[] = repos.map((r) => ({
    key: `repo:${r.id}`, name: r.name, repoId: r.id,
    items: worktrees.filter((w) => w.repoId === r.id).map((w) => {
      const label = worktreeLabel(w);
      const title = worktreeTitle(w, r.name);
      return { pinId: localPinId(w), label, detail: [title, w.branch !== label ? w.branch : ''].filter(Boolean).join(' · '), haystack: `${label} ${title} ${w.branch} ${r.name}`.toLowerCase() };
    }),
  }));
  const other = worktrees.filter((w) => !repos.some((r) => r.id === w.repoId));
  if (other.length > 0) {
    groups.push({ key: 'repo:other', name: 'Other', repoId: null, items: other.map((w) => {
      const label = worktreeLabel(w);
      return { pinId: localPinId(w), label, detail: w.branch ?? '', haystack: `${label} ${w.branch}`.toLowerCase() };
    }) });
  }
  const byRunner = new Map<string, { name: string; rows: RemoteWorktree[] }>();
  for (const w of remoteWorktrees) {
    const g = byRunner.get(w.runnerId) ?? { name: w.runnerName, rows: [] };
    g.rows.push(w);
    byRunner.set(w.runnerId, g);
  }
  for (const [runnerId, g] of byRunner) {
    groups.push({ key: `runner:${runnerId}`, name: g.name, repoId: null, items: g.rows.map((w) => {
      const label = w.branch ?? w.name;
      const repo = repos.find((r) => r.id === w.localRepoId)?.name ?? w.remoteRepoName ?? '';
      return { pinId: remotePinId(w), label, detail: [repo, `on ${w.runnerName}`].filter(Boolean).join(' · '), haystack: `${label} ${w.name} ${repo} ${w.runnerName}`.toLowerCase() };
    }) });
  }
  return groups.filter((g) => g.items.length > 0);
}

export function WorktreePicker({ repos, worktrees, remoteWorktrees, selected, onToggle, autoFocus = false }: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  remoteWorktrees: RemoteWorktree[];
  selected: Set<string>;
  onToggle: (pinId: string, on: boolean) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const all = pickerGroups(repos, worktrees, remoteWorktrees);
  const groups = all
    .map((g) => ({ ...g, items: q ? g.items.filter((i) => i.haystack.includes(q)) : g.items }))
    .filter((g) => g.items.length > 0);
  const total = all.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <input autoFocus={autoFocus} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search worktrees"
        placeholder="Search worktrees…"
        className="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none" />
      <div className="flex max-h-72 min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        {total === 0 && <p className="px-1 py-2 text-xs text-zinc-600">No worktrees in this space yet.</p>}
        {total > 0 && groups.length === 0 && <p className="px-1 py-2 text-xs text-zinc-600">No match.</p>}
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.name}>
            <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-zinc-500">
              {g.repoId && <RepoAvatar id={g.repoId} name={g.name} />}
              <span className="truncate">{g.name}</span>
            </div>
            <div className="flex flex-col">
              {g.items.map((it) => {
                const on = selected.has(it.pinId);
                return (
                  <label key={it.pinId} className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-900 ${on ? 'text-zinc-100' : 'text-zinc-300'}`}>
                    <input type="checkbox" checked={on} onChange={(e) => onToggle(it.pinId, e.target.checked)} aria-label={it.label}
                      className="h-3.5 w-3.5 shrink-0 accent-sky-500" />
                    <span className="min-w-0 truncate font-mono text-xs">{it.label}</span>
                    {it.detail && <span className="min-w-0 truncate text-xs text-zinc-600">{it.detail}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
