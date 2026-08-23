import { useEffect, useState } from 'react';
import { api } from '../api';
import { useWorkspace } from '../hooks/useWorkspace';
import { parseUnifiedDiff, type ParsedDiff } from '../lib/diff';
import { buildGraph, type GraphSegment } from './commitGraph';

type LogCommit = Awaited<ReturnType<typeof api.worktrees.git.log>>['commits'][number];
type CommitInfo = Awaited<ReturnType<typeof api.worktrees.git.commitInfo>>;

const ROW = 30;
const LANE_W = 13;
const LANE_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#22d3ee', '#a3e635'];

// Bare colored monograms, same grammar as DiffView's file list.
const STATUS_CHIP: Record<string, string> = {
  A: 'text-emerald-400',
  M: 'text-amber-400',
  D: 'text-red-400',
  R: 'text-blue-400',
};

function laneX(lane: number): number {
  return lane * LANE_W + 7;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]!;
}

function segPath(s: GraphSegment, dotLane: number): string {
  const x1 = s.fromDot ? laneX(dotLane) : laneX(s.fromLane);
  const y1 = s.fromDot ? ROW / 2 : 0;
  const x2 = s.toDot ? laneX(dotLane) : laneX(s.toLane);
  const y2 = s.toDot ? ROW / 2 : ROW;
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function GitTreePanel({ worktreePath }: { worktreePath: string }) {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;

  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [info, setInfo] = useState<CommitInfo | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<ParsedDiff | null>(null);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  // Server search results while a query is active; null = no active search.
  const [results, setResults] = useState<LogCommit[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.worktrees.git
      .log(wsId, worktreePath, 100)
      .then((r) => {
        if (!alive) return;
        setCommits(r.commits);
        setHead(r.head);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [wsId, worktreePath]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setInfo(null);
    setFile(null);
    setDiff(null);
    api.worktrees.git
      .commitInfo(wsId, worktreePath, selected)
      .then((r) => alive && setInfo(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [wsId, worktreePath, selected]);

  useEffect(() => {
    if (!selected || !file) return;
    let alive = true;
    setDiff(null);
    api.worktrees.git
      .commitDiff(wsId, worktreePath, selected, file)
      .then((r) => alive && setDiff(parseUnifiedDiff(r.diff)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [wsId, worktreePath, selected, file]);

  // Debounced full-history search on the server (message, author, hash).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api.worktrees.git
        .log(wsId, worktreePath, 100, q)
        .then((r) => alive && setResults(r.commits))
        .catch(() => alive && setResults([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [wsId, worktreePath, query]);

  // Search results lose their parent chains, so they render as a flat list
  // (dots only, no edges); the full graph returns when the query clears.
  const searching = results !== null;
  const visible = results ?? commits;
  const { rows, laneCount } = buildGraph(searching ? [] : commits);
  const svgW = (searching ? 1 : Math.min(laneCount, 10)) * LANE_W + 4;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[26rem] shrink-0 flex-col border-r border-zinc-800">
        <div className="border-b border-zinc-800 p-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commits…"
            aria-label="Search commits"
            className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && <div className="p-3 text-xs text-zinc-600">Loading history…</div>}
        {!loading && visible.length === 0 && (
          <div className="p-3 text-xs text-zinc-600">{searching ? 'No matching commits' : 'No commits'}</div>
        )}
        {visible.map((c, i) => {
          const row = searching ? null : rows[i]!;
          const isHead = c.hash === head;
          const isSelected = selected === c.hash;
          return (
            <button
              key={c.hash}
              onClick={() => setSelected(c.hash)}
              title={`${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString()}`}
              className={`flex w-full items-center gap-2 px-2 text-left text-xs ${
                isSelected ? 'bg-zinc-800' : 'hover:bg-zinc-900'
              }`}
            >
              <svg width={svgW} height={ROW} className="shrink-0">
                {row?.segments.map((s, j) => (
                  <path
                    key={j}
                    d={segPath(s, row.lane)}
                    stroke={laneColor(s.color)}
                    strokeWidth="1.5"
                    fill="none"
                  />
                ))}
                <circle
                  cx={laneX(row?.lane ?? 0)}
                  cy={ROW / 2}
                  r={isHead ? 4.5 : 3.5}
                  fill={laneColor(row?.lane ?? 0)}
                  stroke={isHead ? '#fafafa' : 'none'}
                  strokeWidth={isHead ? 1.5 : 0}
                />
              </svg>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                {(() => {
                  // origin/x and x collapse into one pill; at most two pills
                  // per row with a +N overflow — the subject must stay readable.
                  const names = [...new Set(c.refs.map((r) => r.replace(/^origin\//, '')))];
                  const shown = names.slice(0, 2);
                  const extra = names.length - shown.length;
                  const all = c.refs.join(', ');
                  return (
                    <>
                      {shown.map((r) => (
                        <span
                          key={r}
                          title={all}
                          className="max-w-[8rem] shrink-0 truncate rounded bg-zinc-800 px-1.5 text-[10px] leading-4 text-zinc-400"
                        >
                          {r}
                        </span>
                      ))}
                      {extra > 0 && (
                        <span
                          title={all}
                          className="shrink-0 rounded bg-zinc-800 px-1.5 text-[10px] leading-4 text-zinc-500"
                        >
                          +{extra}
                        </span>
                      )}
                    </>
                  );
                })()}
                <span className={`min-w-0 truncate ${isHead ? 'text-zinc-100' : 'text-zinc-300'}`}>
                  {c.subject}
                </span>
              </span>
              <span className="shrink-0 pr-1 text-[10px] text-zinc-600">
                {c.author.split(' ')[0]} · {relTime(c.date)}
              </span>
            </button>
          );
        })}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {error && <div className="m-3 rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-300">{error}</div>}
        {!selected && !error && (
          <div className="p-4 text-xs text-zinc-600">Select a commit to see its details</div>
        )}
        {info && (
          <div className="p-3">
            <div className="whitespace-pre-wrap text-sm text-zinc-100">{info.message}</div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
              <span>{info.author}</span>
              <span>·</span>
              <span>{new Date(info.date).toLocaleString()}</span>
              <span>·</span>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(info.hash).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                title="Copy full hash"
                className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-300 hover:bg-zinc-700"
              >
                {copied ? 'copied!' : info.hash.slice(0, 8)}
              </button>
            </div>
            <div className="mt-3 border-t border-zinc-800 pt-2">
              {info.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setFile(f.path)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
                    file === f.path ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                  }`}
                >
                  <span className={`w-4 shrink-0 text-center font-mono text-[10px] font-bold ${STATUS_CHIP[f.status] ?? 'text-zinc-400'}`}>
                    {f.status}
                  </span>
                  <span className="min-w-0 truncate text-zinc-300">{f.path}</span>
                  {f.renamedFrom && (
                    <span className="min-w-0 truncate text-[10px] text-zinc-600">← {f.renamedFrom}</span>
                  )}
                </button>
              ))}
              {info.files.length === 0 && <div className="px-2 py-1 text-xs text-zinc-600">No file changes</div>}
            </div>
            {file && diff && (
              <div className="mt-3">
                {diff.binary && <div className="text-xs text-zinc-500">Binary file</div>}
                {diff.hunks.map((h, i) => (
                  <div key={i} className="mb-3 overflow-x-auto rounded border border-zinc-800">
                    <div className="bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-500">{h.header}</div>
                    {h.lines.map((l, j) => (
                      <div
                        key={j}
                        className={`whitespace-pre px-2 font-mono text-[11px] leading-5 ${
                          l.kind === 'add'
                            ? 'bg-emerald-950/40 text-emerald-200'
                            : l.kind === 'del'
                              ? 'bg-red-950/40 text-red-200'
                              : 'text-zinc-400'
                        }`}
                      >
                        {(l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
