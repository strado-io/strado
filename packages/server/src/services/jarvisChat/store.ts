// The per-Focus Jarvis chat log: `<dir>/<focusId>.jsonl` (one entry per line,
// oldest first) and `<dir>/<focusId>.json` (agent, session id). Written
// through one serialized queue, like focuses.ts: appends add a line, upserts
// and trims rewrite the file (tmp + rename; it stays under 2 MB). Both files
// are 0600: the chat can quote what the person typed.
//
// Text is redacted before it is stored, so a token pasted into the chat never
// reaches the disk or another window. On load, a turn still marked running
// (the server stopped mid-turn) reads back interrupted, and half-streamed text
// as finished.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.js';
import { redact } from '../hostTabs/redact.js';
import { JARVIS_LIMITS, type ChatEntry, type JarvisAgent, type JarvisMeta, type NewChatEntry } from './types.js';

/** `removed`: the Focus's chat is gone (the Focus was deleted); streams end. */
export type JarvisChatChange = { entry?: ChatEntry; meta?: JarvisMeta; removed?: true };

export type JarvisChatStore = {
  /** Oldest first: the `limit` entries just before `before` (or the newest). */
  page(focusId: string, opts: { before?: string; limit?: number }): Promise<ChatEntry[]>;
  /** Fills in id and at; redacts secrets. A known id is refused (use upsert). */
  append(focusId: string, entry: NewChatEntry): Promise<ChatEntry>;
  /** Same id replaces in place (streamed text, approval state); a new id appends. */
  upsert(focusId: string, entry: ChatEntry): Promise<ChatEntry>;
  find(focusId: string, entryId: string): Promise<ChatEntry | null>;
  meta(focusId: string): Promise<JarvisMeta>;
  setMeta(focusId: string, patch: Partial<Pick<JarvisMeta, 'agent' | 'sessionId' | 'lastActiveAt'>>): Promise<JarvisMeta>;
  remove(focusId: string): Promise<void>;
  onChange(listener: (focusId: string, change: JarvisChatChange) => void): () => void;
  /** How many chats are held in memory (tests). */
  cached(): { logs: number; metas: number };
};

const R = '[redacted]';
/** The ⌘K history's secret words (lib/jarvis/history.ts) with a value of any
 *  length: `redact()` only takes long values, and a chat line like
 *  "password: hunter2" must not keep hunter2. Never starts on `[`, so text
 *  already redacted stays as it is. */
const SHORT_LABELED =
  /\b([A-Za-z_-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|_authToken)s?)(["']?\s*[=:]\s*["']?)([^\s"',;&[]+)/gi;
const SHORT_BEARER = /\b(bearer\s+)[^\s[]+/gi;

export function redactChat(text: string): string {
  return redact(text).replace(SHORT_LABELED, (_m, label: string, sep: string) => `${label}${sep}${R}`).replace(SHORT_BEARER, `$1${R}`);
}

/** Fields that are ids or enums, never free text. */
const KEEP = new Set(['id', 'at', 'type', 'turnId', 'windowId', 'state', 'action', 'agent', 'done', 'ok', 'wake']);
/** A card's own ids; its label and url are text (a URL can carry a token). */
const CARD_KEEP = new Set(['kind', 'worktree', 'worktreePath', 'tab']);

function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redactChat(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

function redactEntry(e: ChatEntry): ChatEntry {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'card' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).map(([ck, cv]) => [ck, CARD_KEEP.has(ck) ? cv : redactDeep(cv)]));
    } else out[k] = KEEP.has(k) ? v : redactDeep(v);
  }
  return out as ChatEntry;
}

const FOCUS_ID = /^[A-Za-z0-9_-]{1,64}$/;
function checkId(focusId: string): void {
  if (!FOCUS_ID.test(focusId)) throw new AppError('VALIDATION', 'bad focus id');
}

const lineBytes = (e: ChatEntry) => Buffer.byteLength(JSON.stringify(e)) + 1;

type Log = { entries: ChatEntry[]; bytes: number };
type MetaFile = { agent: JarvisAgent; sessionId: string | null; lastActiveAt: string | null };

/** Chats held in memory; the least recently used beyond it are read back
 *  from disk when next needed. */
const CACHE_MAX = 32;

export function createJarvisChatStore(dir: string, opts: { cacheMax?: number } = {}): JarvisChatStore {
  const cacheMax = opts.cacheMax ?? CACHE_MAX;
  const logs = new Map<string, Log>();
  const metas = new Map<string, MetaFile>();
  /** Focuses whose chat was removed: Focus ids are never reused, and a turn
   *  that ends after the delete must not write the file back. */
  const removed = new Set<string>();
  const listeners = new Set<(focusId: string, change: JarvisChatChange) => void>();
  let queue: Promise<void> = Promise.resolve();

  const logPath = (id: string) => path.join(dir, `${id}.jsonl`);
  const metaPath = (id: string) => path.join(dir, `${id}.json`);

  function enqueue<T>(focusId: string, fn: () => Promise<T>): Promise<T> {
    // async so a bad id rejects rather than throwing synchronously
    const next = queue.then(() => {
      checkId(focusId);
      return fn();
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Marks a chat used; past the cap, the least recently used one's log and
   *  meta leave memory together (the files are the truth). */
  const order = new Set<string>();
  function touch(focusId: string): void {
    order.delete(focusId);
    order.add(focusId);
    while (order.size > cacheMax) {
      const old = order.values().next().value!;
      order.delete(old);
      logs.delete(old);
      metas.delete(old);
    }
  }

  function writable(focusId: string): void {
    if (removed.has(focusId)) throw new AppError('NOT_FOUND', 'focus was deleted');
  }

  function emit(focusId: string, change: JarvisChatChange): void {
    for (const l of listeners) {
      try {
        l(focusId, change);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  async function load(focusId: string): Promise<Log> {
    if (removed.has(focusId)) return { entries: [], bytes: 0 }; // never read back
    touch(focusId);
    const hit = logs.get(focusId);
    if (hit) return hit;
    let raw = '';
    try {
      raw = await fs.readFile(logPath(focusId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const entries: ChatEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e: ChatEntry;
      try {
        e = JSON.parse(line) as ChatEntry;
      } catch {
        continue; // a torn last line from a crash; the rest still counts
      }
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.type !== 'string') continue;
      if (e.type === 'turn' && e.state === 'running') e = { ...e, state: 'interrupted' };
      if (e.type === 'jarvis' && !e.done) e = { ...e, done: true };
      entries.push(e);
    }
    const log = { entries, bytes: entries.reduce((n, e) => n + lineBytes(e), 0) };
    logs.set(focusId, log);
    return log;
  }

  async function loadMeta(focusId: string): Promise<MetaFile> {
    if (removed.has(focusId)) return { agent: 'claude', sessionId: null, lastActiveAt: null };
    touch(focusId);
    const hit = metas.get(focusId);
    if (hit) return hit;
    let m: MetaFile = { agent: 'claude', sessionId: null, lastActiveAt: null };
    try {
      const r = JSON.parse(await fs.readFile(metaPath(focusId), 'utf8')) as Partial<MetaFile>;
      m = {
        agent: r.agent === 'claude' ? r.agent : 'claude',
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        lastActiveAt: typeof r.lastActiveAt === 'string' ? r.lastActiveAt : null,
      };
    } catch {
      /* none yet, or unreadable: a fresh session */
    }
    metas.set(focusId, m);
    return m;
  }

  async function writeAtomic(file: string, data: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async function rewrite(focusId: string, log: Log): Promise<void> {
    await writeAtomic(logPath(focusId), log.entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  /** Drops the oldest entries past the caps; true when any went. A pending
   *  approval and the running turn's entries are never dropped: the person
   *  still has to answer the one, and the runner still upserts the other. */
  function trim(log: Log): boolean {
    const over = () => log.entries.length > JARVIS_LIMITS.logEntries || log.bytes > JARVIS_LIMITS.logBytes;
    if (!over()) return false;
    const running = new Set(log.entries.flatMap((e) => (e.type === 'turn' && e.state === 'running' ? [e.turnId] : [])));
    const kept = (e: ChatEntry) => (e.type === 'approval' && e.state === 'pending') || ('turnId' in e && running.has(e.turnId));
    let dropped = false;
    let i = 0;
    while (over() && i < log.entries.length - 1) {
      if (kept(log.entries[i]!)) {
        i++;
        continue;
      }
      log.bytes -= lineBytes(log.entries.splice(i, 1)[0]!);
      dropped = true;
    }
    return dropped;
  }

  async function metaOf(focusId: string): Promise<JarvisMeta> {
    const [log, m] = await Promise.all([load(focusId), loadMeta(focusId)]);
    const last = log.entries.at(-1)?.at ?? null;
    return {
      focusId,
      agent: m.agent,
      sessionId: m.sessionId,
      lastActiveAt: !m.lastActiveAt ? last : !last ? m.lastActiveAt : last > m.lastActiveAt ? last : m.lastActiveAt,
      pendingApprovals: log.entries.filter((e) => e.type === 'approval' && e.state === 'pending').length,
      running: log.entries.some((e) => e.type === 'turn' && e.state === 'running'),
    };
  }

  /** Turns and approvals move the meta (running, pending count). */
  async function changed(focusId: string, entry: ChatEntry): Promise<void> {
    const moves = entry.type === 'turn' || entry.type === 'approval';
    emit(focusId, { entry, ...(moves ? { meta: await metaOf(focusId) } : {}) });
  }

  return {
    page: (focusId, opts) =>
      enqueue(focusId, async () => {
        const { entries } = await load(focusId);
        const limit = Math.max(1, Math.min(opts.limit ?? 100, JARVIS_LIMITS.pageMax));
        let end = entries.length;
        if (opts.before !== undefined) {
          end = entries.findIndex((e) => e.id === opts.before);
          if (end < 0) return [];
        }
        return entries.slice(Math.max(0, end - limit), end);
      }),

    append: (focusId, input) =>
      enqueue(focusId, async () => {
        writable(focusId);
        const log = await load(focusId);
        const id = input.id ?? crypto.randomBytes(8).toString('hex');
        if (log.entries.some((e) => e.id === id)) throw new AppError('CONFLICT', 'entry already exists');
        const entry = redactEntry({ ...input, id, at: new Date().toISOString() } as ChatEntry);
        log.entries.push(entry);
        log.bytes += lineBytes(entry);
        if (trim(log)) await rewrite(focusId, log);
        else {
          await fs.mkdir(dir, { recursive: true, mode: 0o700 });
          await fs.appendFile(logPath(focusId), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        }
        await changed(focusId, entry);
        return entry;
      }),

    upsert: (focusId, input) =>
      enqueue(focusId, async () => {
        writable(focusId);
        const log = await load(focusId);
        const entry = redactEntry(input);
        const i = log.entries.findIndex((e) => e.id === entry.id);
        if (i < 0) log.entries.push(entry);
        else {
          log.bytes -= lineBytes(log.entries[i]!);
          log.entries[i] = entry;
        }
        log.bytes += lineBytes(entry);
        trim(log);
        await rewrite(focusId, log);
        await changed(focusId, entry);
        return entry;
      }),

    find: (focusId, entryId) => enqueue(focusId, async () => (await load(focusId)).entries.find((e) => e.id === entryId) ?? null),

    meta: (focusId) => enqueue(focusId, () => metaOf(focusId)),

    setMeta: (focusId, patch) =>
      enqueue(focusId, async () => {
        writable(focusId);
        const m = { ...(await loadMeta(focusId)) };
        if (patch.agent !== undefined) m.agent = patch.agent;
        if (patch.sessionId !== undefined) m.sessionId = patch.sessionId;
        if (patch.lastActiveAt !== undefined) m.lastActiveAt = patch.lastActiveAt;
        await writeAtomic(metaPath(focusId), JSON.stringify(m, null, 2));
        metas.set(focusId, m);
        const meta = await metaOf(focusId);
        emit(focusId, { meta });
        return meta;
      }),

    remove: (focusId) =>
      enqueue(focusId, async () => {
        removed.add(focusId);
        order.delete(focusId);
        logs.delete(focusId);
        metas.delete(focusId);
        await fs.rm(logPath(focusId), { force: true });
        await fs.rm(metaPath(focusId), { force: true });
        emit(focusId, { removed: true });
      }),

    cached: () => ({ logs: logs.size, metas: metas.size }),

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
