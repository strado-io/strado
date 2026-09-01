import fsp from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectDirs, claudeTranscripts, readClaudeEvents, type UsageEvent } from './claudeLogs.js';
import { codexRolloutFiles, readCodexEvents, type RateLimitSnapshot } from './codexLogs.js';
import { fullRateUsd, isKnownModel, normalizeModelId, priceUsd } from './pricing.js';

export type Agent = 'claude' | 'codex';

export type WorktreeLabel = { path: string; label: string };

export type AgentTotals = { cost: number; tokens: number };

export type DayPoint = { date: string; claude: AgentTotals; codex: AgentTotals };

export type ModelRow = {
  id: string;
  agent: Agent;
  cost: number;
  tokens: number;
  /** Percent of total cost, or of total tokens when nothing has a price. */
  share: number;
  priced: boolean;
};

export type WorktreeRow = { label: string; path: string | null; cost: number; tokens: number };

export type UsageTotals = {
  cost: number;
  tokens: number;
  cachedInput: number;
  uncachedInput: number;
  cacheWrite: number;
  output: number;
  cacheSavings: number;
  /** How many times cheaper the cached run was; 1 when nothing was cached. */
  cacheSavingsMultiple: number;
};

export type UsageSummary = {
  range: { from: string; to: string };
  totals: UsageTotals;
  byAgent: Record<Agent, AgentTotals>;
  series: DayPoint[];
  models: ModelRow[];
  worktrees: WorktreeRow[];
  skipped: number;
  /** Bytes parsed on this call — 0 when everything came from the cache. */
  bytesRead: number;
};

/**
 * Per (date, model) totals for one log file, in a fixed tuple so a cache
 * covering months of transcripts stays small on disk:
 * [cost, fullRateCost, input, cacheWrite5m, cacheWrite1h, cacheRead, output].
 */
type Tally = [number, number, number, number, number, number, number];

/**
 * Buckets live under the file they came from. That is what makes a rewritten
 * log safe: dropping the file's entry drops exactly its contribution, where a
 * single global bucket map could only ever add.
 */
type FileState = {
  offset: number;
  size: number;
  mtimeMs: number;
  agent: Agent;
  /**
   * Session cwd. One log file is one session, so its turns share a directory;
   * if a session somehow moves, later turns keep the first cwd seen.
   */
  cwd: string;
  /** Model in force at the last read, so appended turns stay attributed. */
  model?: string;
  days: Record<string, Record<string, Tally>>;
};

type CacheShape = {
  version: number;
  files: Record<string, FileState>;
  codexRateLimits: RateLimitSnapshot | null;
  skipped: number;
};

const CACHE_VERSION = 6;
const DAY_MS = 86_400_000;
/** Longest window the UI offers, plus room; older days are dropped. */
const RETAIN_DAYS = 120;

const emptyCache = (): CacheShape => ({
  version: CACHE_VERSION,
  files: {},
  codexRateLimits: null,
  skipped: 0,
});

const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

const emptyTally = (): Tally => [0, 0, 0, 0, 0, 0, 0];

export type UsageStoreOptions = {
  /** Home dir holding `.claude` and `.codex`; `app.deps.agentHomeDir`. */
  agentHomeDir: string;
  /** Where the parse cache lives; `app.deps.homeStateDir`. */
  stateDir: string;
};

export type UsageStore = {
  summary(input: { days: number; worktrees: WorktreeLabel[] }): Promise<UsageSummary>;
  codexRateLimits(): Promise<RateLimitSnapshot | null>;
};

/**
 * Aggregates local agent logs into daily cost buckets.
 *
 * Session logs are append-only, so a file already parsed is re-read from its
 * last byte offset instead of from the top. That keeps the first call (which
 * may cross months of transcripts) the only expensive one; every refresh after
 * it reads only what the agents appended since.
 */
export function createUsageStore({ agentHomeDir, stateDir }: UsageStoreOptions): UsageStore {
  const cacheFile = path.join(stateDir, 'usage-cache.json');
  let cache: CacheShape | null = null;
  let scanning: Promise<number> | null = null;

  async function load(): Promise<CacheShape> {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fsp.readFile(cacheFile, 'utf8')) as CacheShape;
      // A version bump means the tally shape changed; a stale cache would
      // report wrong numbers, so start over rather than migrate.
      cache = parsed.version === CACHE_VERSION ? parsed : emptyCache();
    } catch {
      cache = emptyCache();
    }
    return cache;
  }

  async function persist(state: CacheShape): Promise<void> {
    const cutoff = dayKey(Date.now() - RETAIN_DAYS * DAY_MS);
    for (const file of Object.values(state.files)) {
      for (const date of Object.keys(file.days)) {
        if (date < cutoff) delete file.days[date];
      }
    }
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(state), 'utf8');
    } catch {
      // A read-only state dir costs a re-parse next time, nothing more.
    }
  }

  function add(file: FileState, event: UsageEvent): void {
    const model = normalizeModelId(event.model);
    const date = dayKey(event.ts);
    const day = file.days[date] ?? (file.days[date] = {});
    const tally = day[model] ?? (day[model] = emptyTally());
    tally[0] += priceUsd(model, event.tokens).cost;
    tally[1] += fullRateUsd(model, event.tokens);
    tally[2] += event.tokens.input;
    tally[3] += event.tokens.cacheWrite;
    tally[4] += event.tokens.cacheWrite1h;
    tally[5] += event.tokens.cacheRead;
    tally[6] += event.tokens.output;
    if (!file.cwd && event.cwd) file.cwd = event.cwd;
  }

  /**
   * The file's state to read from, or null when it has not changed. A file that
   * shrank was rewritten rather than appended to, so its tallies are discarded
   * and it is parsed again from the top.
   */
  async function pending(state: CacheShape, file: string, agent: Agent): Promise<FileState | null> {
    let stat: { size: number; mtimeMs: number };
    try {
      const s = await fsp.stat(file);
      stat = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
    const known = state.files[file];
    const fresh = (): FileState => ({
      offset: 0, size: stat.size, mtimeMs: stat.mtimeMs, agent, cwd: '', days: {},
    });
    if (!known) return fresh();
    if (stat.size < known.offset) return fresh();
    if (stat.size === known.size && stat.mtimeMs === known.mtimeMs) return null;
    return { ...known, size: stat.size, mtimeMs: stat.mtimeMs };
  }

  async function scanClaude(state: CacheShape): Promise<number> {
    let bytes = 0;
    const root = path.join(agentHomeDir, '.claude', 'projects');
    for (const dir of await claudeProjectDirs(root)) {
      for (const file of await claudeTranscripts(dir)) {
        const next = await pending(state, file, 'claude');
        if (!next) continue;
        const { events, offset, skipped } = await readClaudeEvents(file, next.offset);
        bytes += offset - next.offset;
        state.skipped += skipped;
        for (const event of events) add(next, event);
        next.offset = offset;
        state.files[file] = next;
      }
    }
    return bytes;
  }

  async function scanCodex(state: CacheShape): Promise<number> {
    let bytes = 0;
    const root = path.join(agentHomeDir, '.codex', 'sessions');
    let newest: RateLimitSnapshot | null = state.codexRateLimits;
    for (const file of await codexRolloutFiles(root)) {
      const next = await pending(state, file, 'codex');
      if (!next) continue;
      const read = await readCodexEvents(file, next.offset, { cwd: next.cwd, model: next.model });
      bytes += read.offset - next.offset;
      state.skipped += read.skipped;
      for (const event of read.events) add(next, event);
      if (read.rateLimits && (!newest || read.rateLimits.capturedAt >= newest.capturedAt)) {
        newest = read.rateLimits;
      }
      next.offset = read.offset;
      next.model = read.model;
      if (!next.cwd && read.cwd) next.cwd = read.cwd;
      state.files[file] = next;
    }
    state.codexRateLimits = newest;
    return bytes;
  }

  /** One scan at a time: concurrent callers share the in-flight pass. */
  async function scan(): Promise<number> {
    if (scanning) return scanning;
    scanning = (async () => {
      const state = await load();
      const bytes = (await scanClaude(state)) + (await scanCodex(state));
      await persist(state);
      return bytes;
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  function aggregate(state: CacheShape, days: number, worktrees: WorktreeLabel[], bytesRead: number): UsageSummary {
    const now = Date.now();
    const fromMs = now - (days - 1) * DAY_MS;
    const fromDate = dayKey(fromMs);

    const series = new Map<string, DayPoint>();
    for (let index = 0; index < days; index += 1) {
      const date = dayKey(fromMs + index * DAY_MS);
      series.set(date, { date, claude: { cost: 0, tokens: 0 }, codex: { cost: 0, tokens: 0 } });
    }

    const totals: UsageTotals = {
      cost: 0, tokens: 0, cachedInput: 0, uncachedInput: 0, cacheWrite: 0,
      output: 0, cacheSavings: 0, cacheSavingsMultiple: 1,
    };
    const byAgent: Record<Agent, AgentTotals> = {
      claude: { cost: 0, tokens: 0 },
      codex: { cost: 0, tokens: 0 },
    };
    const models = new Map<string, ModelRow>();
    const trees = new Map<string, WorktreeRow>();
    let fullRate = 0;

    /**
     * A session cwd may be a subdirectory of the worktree it belongs to, so the
     * longest matching prefix wins and a nested worktree keeps its own row.
     */
    const labelFor = (cwd: string): WorktreeLabel | null => {
      if (!cwd) return null;
      const exact = worktrees.find((tree) => tree.path === cwd);
      if (exact) return exact;
      return worktrees
        .filter((tree) => cwd.startsWith(`${tree.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
    };

    for (const file of Object.values(state.files)) {
      const match = labelFor(file.cwd);
      const treeKey = match ? match.path : 'unattributed';
      for (const [date, byModel] of Object.entries(file.days)) {
        if (date < fromDate) continue;
        const point = series.get(date);
        if (!point) continue;
        for (const [model, tally] of Object.entries(byModel)) {
          const [cost, atFullRate, input, write5m, write1h, cacheRead, output] = tally;
          const cacheWrite = write5m + write1h;
          const tokens = input + cacheWrite + cacheRead + output;

          point[file.agent].cost += cost;
          point[file.agent].tokens += tokens;
          byAgent[file.agent].cost += cost;
          byAgent[file.agent].tokens += tokens;

          totals.cost += cost;
          totals.tokens += tokens;
          totals.cachedInput += cacheRead;
          totals.uncachedInput += input;
          totals.cacheWrite += cacheWrite;
          totals.output += output;
          fullRate += atFullRate;

          const modelRow = models.get(model) ?? {
            id: model, agent: file.agent, cost: 0, tokens: 0, share: 0, priced: isKnownModel(model),
          };
          modelRow.cost += cost;
          modelRow.tokens += tokens;
          models.set(model, modelRow);

          const treeRow = trees.get(treeKey) ?? {
            label: match ? match.label : 'Unattributed',
            path: match ? match.path : null,
            cost: 0,
            tokens: 0,
          };
          treeRow.cost += cost;
          treeRow.tokens += tokens;
          trees.set(treeKey, treeRow);
        }
      }
    }

    totals.cacheSavings = Math.max(0, fullRate - totals.cost);
    totals.cacheSavingsMultiple = totals.cost > 0 ? fullRate / totals.cost : 1;

    // Share is by cost, except when nothing in range has a price (an unpriced
    // model only) — then a token share is the honest fallback.
    const byCost = totals.cost > 0;
    const shareBase = byCost ? totals.cost : totals.tokens;
    const modelRows = [...models.values()]
      .map((row) => ({
        ...row,
        share: shareBase > 0 ? ((byCost ? row.cost : row.tokens) / shareBase) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

    return {
      range: { from: fromDate, to: dayKey(now) },
      totals,
      byAgent,
      series: [...series.values()],
      models: modelRows,
      worktrees: [...trees.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
      skipped: state.skipped,
      bytesRead,
    };
  }

  return {
    async summary({ days, worktrees }) {
      const bytesRead = await scan();
      const state = await load();
      return aggregate(state, days, worktrees, bytesRead);
    },
    async codexRateLimits() {
      await scan();
      return (await load()).codexRateLimits;
    },
  };
}
