// The sandbox containers on this runner, for the host Sandboxes tab: what
// `ps` and one `stats --no-stream` sample say, nothing from `inspect` (its
// output carries the container's env, tokens included).
import type { ExecFn, SandboxRuntime } from '../sandbox/runtime.js';
import type { SandboxRow } from './types.js';

type Agent = SandboxRow['staleLogins'][number];

export type ContainerDeps = {
  rt: SandboxRuntime;
  exec: ExecFn;
  /** Display names for a worktree path, when this runner knows it. */
  describe(worktreePath: string): Promise<{ repoName: string | null; worktreeName: string | null } | null>;
  /** The runner store's per-agent login change times. */
  changedAt(): Promise<Partial<Record<Agent, number>>>;
};

const PREFIX = 'strado-sbx-';
const LABEL = 'io.strado.worktree';

/** Logins a container takes in only at create. Codex, OpenCode and Pi live in
 *  the shared HOME volume, so a running container sees their changes at once. */
const BAKED_IN: Agent[] = ['claude'];

type Raw = { name: string; state: string; image: string; createdAt: number; startedAt: number | null; worktreePath: string | null };

function statusOf(state: string): SandboxRow['status'] {
  const s = state.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'created' || s === 'configured' || s === 'initialized') return 'creating';
  if (['exited', 'stopped', 'paused', 'dead', 'stopping', 'removing'].includes(s)) return 'stopped';
  return 'unknown';
}

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** "86.61MB", "12.5MiB", "0B" → bytes; null when unreadable. */
export function parseSize(s: string): number | null {
  const m = /^\s*([\d.]+)\s*([kmgt]?i?b)\s*$/i.exec(s);
  const unit = m ? UNITS[m[2]!.toLowerCase()] : undefined;
  if (!m || unit === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * unit) : null;
}

const percent = (s: unknown) => {
  const n = Number.parseFloat(String(s ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
};

async function psPodman(deps: ContainerDeps): Promise<Raw[]> {
  const r = await deps.exec(deps.rt.bin, ['ps', '-a', '--filter', `name=^${PREFIX}`, '--format', 'json'], 15_000);
  if (r.code !== 0) return [];
  const list = JSON.parse(r.stdout || '[]') as {
    Names?: string[];
    State?: string;
    Image?: string;
    Created?: number;
    StartedAt?: number;
    Labels?: Record<string, string> | null;
  }[];
  return list.map((c) => ({
    name: c.Names?.[0] ?? '',
    state: c.State ?? '',
    image: c.Image ?? '',
    createdAt: (c.Created ?? 0) * 1000,
    startedAt: c.StartedAt ? c.StartedAt * 1000 : null,
    worktreePath: c.Labels?.[LABEL] || null,
  }));
}

async function psDocker(deps: ContainerDeps): Promise<Raw[]> {
  // Tab-separated: a worktree path may hold commas, which docker's .Labels joins with.
  const fmt = `{{.Names}}\t{{.State}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Label "${LABEL}"}}`;
  const r = await deps.exec(deps.rt.bin, ['ps', '-a', '--filter', `name=^${PREFIX}`, '--format', fmt], 15_000);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [name = '', state = '', image = '', created = '', label = ''] = line.split('\t');
    // "2026-10-24 08:19:40 +0000 UTC"
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})/.exec(created);
    const createdAt = m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : 0;
    // docker ps has no start time; uptime stays unknown.
    return { name, state, image, createdAt: Number.isFinite(createdAt) ? createdAt : 0, startedAt: null, worktreePath: label || null };
  });
}

async function stats(deps: ContainerDeps): Promise<Map<string, { cpu: number | null; mem: number | null; limit: number | null }>> {
  const out = new Map<string, { cpu: number | null; mem: number | null; limit: number | null }>();
  const podman = deps.rt.bin === 'podman';
  const r = await deps.exec(deps.rt.bin, ['stats', '--no-stream', '--format', podman ? 'json' : '{{json .}}'], 20_000).catch(() => null);
  if (!r || r.code !== 0) return out;
  try {
    const rows = (podman
      ? (JSON.parse(r.stdout || '[]') as Record<string, string>[])
      : r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>));
    for (const s of rows) {
      const name = podman ? s.name : s.Name;
      const [mem = '', limit = ''] = String((podman ? s.mem_usage : s.MemUsage) ?? '').split('/');
      if (name) out.set(name, { cpu: percent(podman ? s.cpu_percent : s.CPUPerc), mem: parseSize(mem), limit: parseSize(limit) });
    }
  } catch {
    /* no usage this time */
  }
  return out;
}

export async function listContainers(deps: ContainerDeps): Promise<SandboxRow[]> {
  let raws: Raw[];
  try {
    raws = deps.rt.bin === 'podman' ? await psPodman(deps) : await psDocker(deps);
  } catch {
    return [];
  }
  raws = raws.filter((c) => c.name.startsWith(PREFIX));
  if (!raws.length) return [];
  const [usage, changed] = await Promise.all([stats(deps), deps.changedAt().catch((): Partial<Record<Agent, number>> => ({}))]);
  return Promise.all(
    raws.map(async (c): Promise<SandboxRow> => {
      const names = c.worktreePath ? await deps.describe(c.worktreePath).catch(() => null) : null;
      const status = statusOf(c.state);
      const u = status === 'running' ? usage.get(c.name) : undefined;
      return {
        slug: c.name.slice(PREFIX.length),
        worktreePath: c.worktreePath,
        repoName: names?.repoName ?? null,
        worktreeName: names?.worktreeName ?? null,
        status,
        image: c.image,
        createdAt: c.createdAt,
        startedAt: status === 'running' ? c.startedAt : null,
        cpuPercent: u?.cpu ?? null,
        memBytes: u?.mem ?? null,
        memLimitBytes: u?.limit ?? null,
        staleLogins: BAKED_IN.filter((a) => (changed[a] ?? 0) > c.createdAt),
      };
    }),
  );
}
