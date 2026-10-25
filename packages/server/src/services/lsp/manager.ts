// Language servers for the Files tab, on demand. One server per (worktree,
// server id), started by the first navigation request for its language,
// stopped after LSP_LIMITS.idleMs unused, at most LSP_LIMITS.maxServers on the
// machine (the least recently used goes first). When there is no server to
// ask, or it cannot answer in time, the answer comes from a whole-word search
// and says why.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInside, safeRel } from '../files/files.js';
import { FILES_LIMITS } from '../files/types.js';
import { classifyDefinitions, isDefinition, searchWord } from '../files/search.js';
import type { SearchAnswer } from './types.js';
import { redact } from '../hostTabs/redact.js';
import { LspClient, LspError } from './client.js';
import { npmGlobalRoot, tsserverPathFor } from './tsserver.js';
import { installOptions, type Detect } from './detect.js';
import type { LspEnabledStore } from './store.js';
import {
  LSP_LIMITS,
  LSP_SERVERS,
  type HoverAnswer,
  type LspServerId,
  type LspServerSpec,
  type LspServerStatus,
  type NavAnswer,
  type NavFallback,
  type NavHit,
  type OutlineSymbol,
} from './types.js';

export type SearchFallback = {
  searchWord(root: string, sym: string): Promise<SearchAnswer>;
  isDefinition(hit: NavHit, sym: string): boolean;
  classifyDefinitions(hits: NavHit[], sym: string): NavHit[];
};

export type LspManagerDeps = {
  detect: Detect;
  store: LspEnabledStore;
  specs?: LspServerSpec[];
  search?: SearchFallback;
  limits?: Partial<{ -readonly [K in keyof typeof LSP_LIMITS]: number }>;
  /** How long the first open waits for a project load to begin (default 300 ms). */
  progressGraceMs?: number;
  /** Resident memory of a pid in bytes, null when it cannot be read. */
  rss?: (pid: number) => Promise<number | null>;
  /** `npm root -g`, for a TypeScript install to hand typescript-language-server. */
  npmRoot?: () => Promise<string | null>;
  /** The server log: a failure's reason, once per change. */
  log?: (line: string) => void;
  now?: () => number;
};

export type OutlineAnswer = { server: LspServerId; symbols: OutlineSymbol[] } | { server: null; symbols: [] };

export type LspManager = {
  definition(worktree: string, rel: string, line: number, col: number): Promise<NavAnswer>;
  references(worktree: string, rel: string, line: number, col: number): Promise<NavAnswer>;
  hover(worktree: string, rel: string, line: number, col: number): Promise<HoverAnswer>;
  outline(worktree: string, rel: string): Promise<OutlineAnswer>;
  servers(): Promise<LspServerStatus[]>;
  setEnabled(id: LspServerId, enabled: boolean): Promise<void>;
  /** Stops every running instance of that server. */
  stop(id: LspServerId): Promise<void>;
  /** Stops servers unused for idleMs. Runs on a timer; exposed for tests. */
  sweep(): Promise<void>;
  closeAll(): Promise<void>;
};

const SYMBOL_KINDS: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field',
  9: 'ctor', 10: 'enum', 11: 'interface', 12: 'func', 13: 'var', 14: 'const', 15: 'string', 16: 'number',
  17: 'bool', 18: 'array', 19: 'object', 20: 'key', 21: 'null', 22: 'enum', 23: 'struct', 24: 'event',
  25: 'operator', 26: 'type',
};

/** The LSP languageId for a file the spec serves. */
function languageId(spec: LspServerSpec, ext: string): string {
  switch (spec.id) {
    case 'typescript':
      return { '.tsx': 'typescriptreact', '.jsx': 'javascriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript' }[ext] ?? 'typescript';
    case 'clangd':
      return ext === '.c' || ext === '.h' ? 'c' : 'cpp';
    case 'texlab':
      return ext === '.bib' ? 'bibtex' : 'latex';
    default:
      return { pyright: 'python', gopls: 'go', 'rust-analyzer': 'rust', jdtls: 'java', solargraph: 'ruby', lua: 'lua', zls: 'zig', omnisharp: 'csharp' }[spec.id] ?? spec.id;
  }
}

function readRss(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 }, (err, stdout) => {
      const kb = Number(String(stdout ?? '').trim());
      resolve(err || !Number.isFinite(kb) || kb <= 0 ? null : kb * 1024);
    });
  });
}

type Pos = { line: number; character: number };
type Range = { start: Pos; end: Pos };
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetRange: Range; targetSelectionRange?: Range };

function toLocations(result: unknown): Location[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  const out: Location[] = [];
  for (const l of list as (Partial<Location> & Partial<LocationLink>)[]) {
    if (l && typeof l.uri === 'string' && l.range) out.push({ uri: l.uri, range: l.range });
    else if (l && typeof l.targetUri === 'string' && (l.targetSelectionRange || l.targetRange)) {
      out.push({ uri: l.targetUri, range: (l.targetSelectionRange ?? l.targetRange)! });
    }
  }
  return out;
}

function hoverMarkdown(contents: unknown): string {
  const one = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
      const o = c as { kind?: string; language?: string; value?: string };
      if (typeof o.value !== 'string') return '';
      // A MarkedString with a language is code; MarkupContent is already markdown.
      return o.language ? `\`\`\`${o.language}\n${o.value}\n\`\`\`` : o.value;
    }
    return '';
  };
  return (Array.isArray(contents) ? contents.map(one) : [one(contents)]).filter((s) => s.trim()).join('\n\n').trim();
}

type RawSymbol = {
  name: string;
  kind: number;
  range?: Range;
  selectionRange?: Range;
  location?: Location;
  children?: RawSymbol[];
};

function toOutline(list: RawSymbol[]): OutlineSymbol[] {
  return list
    .filter((s) => s && typeof s.name === 'string')
    .map((s) => {
      const at = s.selectionRange ?? s.range ?? s.location?.range;
      const sym: OutlineSymbol = {
        name: s.name,
        kind: SYMBOL_KINDS[s.kind] ?? 'symbol',
        line: (at?.start.line ?? 0) + 1,
        col: (at?.start.character ?? 0) + 1,
      };
      if (Array.isArray(s.children) && s.children.length) sym.children = toOutline(s.children);
      return sym;
    });
}

/** The identifier at a 1-based (line, col) of the file, or null. */
async function wordAt(abs: string, line: number, col: number): Promise<string | null> {
  const text = (await fs.readFile(abs, 'utf8').catch(() => '')).split('\n')[line - 1] ?? '';
  const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_$]/u.test(ch);
  let from = Math.min(Math.max(col - 1, 0), text.length);
  // Just after a word (the caret at its end) still means that word.
  if (!isWord(text[from]) && isWord(text[from - 1])) from--;
  if (!isWord(text[from])) return null;
  let to = from;
  while (from > 0 && isWord(text[from - 1])) from--;
  while (isWord(text[to])) to++;
  return text.slice(from, to);
}

/** Names that look like a secret. AUTH also drops SSH_AUTH_SOCK: harmless
 *  (a language server has no business with the ssh agent), and deliberate. */
const SECRET_SHAPED = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH|(^|_)(KEY|DSN)($|_)/i;
/** A URL carrying credentials: postgres://user:pw@host, redis://:pw@host. */
const URL_USERINFO = /:\/\/[^/\s:@]*:[^@\s]+@/;
/** Strado's own identity, and providers whose variables are all credentials or config for them. */
const DENIED_PREFIX = /^(STRADO_|ANTHROPIC_|OPENAI_|CLAUDE_CODE_|GH_|GITHUB_|GITLAB_|AWS_SECRET|AWS_SESSION|OPENROUTER_|ELEVENLABS_)/i;

/** The user's env reaches the server (toolchains need GOPRIVATE, venvs, …),
 *  minus Strado's identity and anything shaped like a credential. */
export function envAllowed(name: string, value = ''): boolean {
  return name !== 'PORT' && !SECRET_SHAPED.test(name) && !DENIED_PREFIX.test(name) && !URL_USERINFO.test(value);
}

type Entry = {
  key: string;
  spec: LspServerSpec;
  root: string;
  client: LspClient;
  ready: Promise<void>;
  state: 'starting' | 'ready' | 'failed';
  startedAt: number;
  lastUsedAt: number;
  stopping: boolean;
  /** Its failure was already counted: an initialize error and the exit that
   *  follows it (or the other way round) are one failure. */
  failed: boolean;
};

class Fallback extends Error {
  constructor(readonly reason: NavFallback, readonly spec?: LspServerSpec) {
    super(reason);
  }
}

export function createLspManager(deps: LspManagerDeps): LspManager {
  const specs = deps.specs ?? LSP_SERVERS;
  const limits = { ...LSP_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const rss = deps.rss ?? readRss;
  const search: SearchFallback = deps.search ?? { searchWord, isDefinition, classifyDefinitions };
  const entries = new Map<string, Entry>();
  /** A start in flight, so concurrent first requests share one server. */
  const starting = new Map<string, Promise<Entry>>();
  /** Crashes per key since its last good answer: one retry, then 'failed'. */
  const crashes = new Map<string, number>();
  /** The binary and options a key failed with: a change (an install, a new
   *  TypeScript) earns a fresh try. */
  const failedConfig = new Map<string, string>();
  /** Why each server last failed, for Settings. */
  const lastError = new Map<LspServerId, string>();
  const npmRoot = deps.npmRoot ?? (async () => npmGlobalRoot(await serverEnv(null)));

  function recordError(id: LspServerId, message: string): void {
    const clean = redact(message).trim().slice(-2048);
    if (lastError.get(id) === clean) return;
    lastError.set(id, clean);
    deps.log?.(`language server ${id}: ${clean}`);
  }

  const sweepTimer = setInterval(() => void sweep(), Math.min(limits.idleMs / 4, 60_000));
  sweepTimer.unref();

  const specFor = (rel: string) => {
    const ext = path.posix.extname(rel).toLowerCase();
    return { ext, spec: specs.find((s) => s.extensions.includes(ext)) };
  };

  async function stopEntry(e: Entry): Promise<void> {
    e.stopping = true;
    if (entries.get(e.key) === e) entries.delete(e.key);
    await e.client.stop().catch(() => e.client.kill());
  }

  /** The server's environment: a language server runs repo code (build
   *  scripts, proc macros, Gradle), so no token or key of the user's or of
   *  Strado's reaches it (envAllowed). node and the common bin dirs go on PATH
   *  (a server's own `#!/usr/bin/env node` must work from a dock launch). */
  async function serverEnv(binary: string | null): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && envAllowed(k, v)) env[k] = v;
    // The server's own bin dir first: an nvm-installed server runs on the node it was installed with.
    const first = binary ? [path.dirname(binary)] : [];
    env.PATH = [...new Set([...first, path.dirname(process.execPath), ...(await deps.detect.dirs())])].join(path.delimiter);
    return env;
  }

  /** Server-specific initializationOptions, or undefined. */
  async function initOptions(spec: LspServerSpec, root: string, binary: string): Promise<unknown> {
    if (spec.id !== 'typescript') return undefined;
    const tsserver = await tsserverPathFor(root, binary, npmRoot);
    return tsserver ? { tsserver: { path: tsserver } } : undefined;
  }

  /** Counts one failure (crash or failed initialize) and frees the slot at
   *  once, so the very next request gets its retry. */
  function fail(entry: Entry, why: string): void {
    entry.state = 'failed';
    if (entry.failed) return;
    entry.failed = true;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    crashes.set(entry.key, (crashes.get(entry.key) ?? 0) + 1);
    recordError(entry.spec.id, why);
  }

  /** Everything up to entries.set runs without an await, so the size check
   *  and the insert cannot interleave with another start. */
  function start(spec: LspServerSpec, root: string, binary: string, env: NodeJS.ProcessEnv, options: unknown): Entry {
    // Make room: the least recently used goes first.
    while (entries.size >= limits.maxServers) {
      const lru = [...entries.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]!;
      void stopEntry(lru);
    }
    const key = `${root}\0${spec.id}`;
    const t = now();
    const entry: Entry = {
      key, spec, root, state: 'starting', startedAt: t, lastUsedAt: t, stopping: false, failed: false,
      ready: Promise.resolve(),
      client: new LspClient({
        argv: [binary, ...spec.cmd.slice(1)],
        root,
        env,
        onExit: (code) => {
          if (entries.get(key) === entry) entries.delete(key);
          if (!entry.stopping) {
            const tail = entry.client.stderrTail.trim();
            fail(entry, `exited with code ${code ?? 'signal'}${tail ? `: ${tail}` : ''}`);
          }
        },
      }),
    };
    entry.ready = entry.client.initialize(limits.startMs, options).then(
      () => {
        entry.state = 'ready';
        lastError.delete(spec.id);
      },
      (err) => {
        // An exit got here first (onExit runs before the rejection) and said why.
        fail(entry, `initialize failed: ${err instanceof Error ? err.message : String(err)}`);
        entry.client.kill();
        throw err;
      },
    );
    entry.ready.catch(() => {});
    entries.set(key, entry);
    return entry;
  }

  /** The ready server for this file, or a Fallback saying why there is none. */
  async function serverFor(worktree: string, rel: string): Promise<{ entry: Entry; abs: string; uri: string }> {
    const { realRoot, real: abs } = await resolveInside(worktree, safeRel(rel));
    const { ext, spec } = specFor(rel);
    if (!spec) throw new Fallback('no-server');
    if (!(await deps.store.isEnabled(spec.id))) throw new Fallback('disabled', spec);
    const key = `${realRoot}\0${spec.id}`;
    let entry = entries.get(key);
    if (!entry) {
      let pending = starting.get(key);
      if (!pending) {
        pending = (async () => {
          const binary = await deps.detect.which(spec.cmd[0]!);
          if (!binary) throw new Fallback('not-installed', spec);
          const options = await initOptions(spec, realRoot, binary);
          const config = JSON.stringify([binary, options]);
          if ((crashes.get(key) ?? 0) >= 2) {
            if (failedConfig.get(key) === config) throw new Fallback('failed', spec);
            crashes.delete(key);
          }
          failedConfig.set(key, config);
          return start(spec, realRoot, binary, await serverEnv(binary), options);
        })();
        starting.set(key, pending);
        void pending.finally(() => starting.delete(key)).catch(() => {});
      }
      entry = await pending;
    }
    entry.lastUsedAt = now();
    if (entry.state === 'failed') throw new Fallback('failed', spec);
    if (entry.state === 'starting') {
      let timer: NodeJS.Timeout | undefined;
      const slow = new Promise<'slow'>((r) => (timer = setTimeout(() => r('slow'), limits.requestMs)));
      const r = await Promise.race([entry.ready.then(() => 'up' as const, () => 'failed' as const), slow]);
      clearTimeout(timer);
      if (r === 'slow') throw new Fallback('starting', spec);
      if (r === 'failed') throw new Fallback('failed', spec);
    }
    try {
      const uri = await entry.client.sync(abs, languageId(spec, ext));
      // A server still loading the project answers wrong, not slowly: wait
      // (bounded) for it to finish, then ask either way.
      await entry.client.settle(limits.requestMs, deps.progressGraceMs ?? 300);
      return { entry, abs, uri };
    } catch {
      throw new Fallback('failed', spec);
    }
  }

  async function ask<T>(entry: Entry, method: string, params: unknown): Promise<T> {
    try {
      const r = await entry.client.request<T>(method, params, limits.requestMs);
      crashes.delete(entry.key);
      lastError.delete(entry.spec.id);
      return r;
    } catch (err) {
      throw new Fallback(err instanceof LspError && err.kind === 'timeout' ? 'timeout' : 'failed', entry.spec);
    }
  }

  /** LSP locations → hits inside the worktree, with their line as preview. */
  async function toHits(root: string, locs: Location[], sort: boolean): Promise<NavHit[]> {
    const lines = new Map<string, string[]>();
    const seen = new Set<string>();
    const hits: NavHit[] = [];
    for (const l of locs) {
      let abs: string;
      try {
        abs = fileURLToPath(l.uri);
      } catch {
        continue;
      }
      // Outside the worktree (a library, the stdlib), inside .git, or through
      // a symlink that leaves it: the tab cannot open it, so it is not offered.
      const rel = path.relative(root, abs);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      const relPosix = rel.split(path.sep).join('/');
      let real: string;
      try {
        real = (await resolveInside(root, safeRel(relPosix))).real;
      } catch {
        continue;
      }
      const line = l.range.start.line + 1;
      const col = l.range.start.character + 1;
      const id = `${relPosix}:${line}:${col}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!lines.has(real)) {
        // A reference into a huge generated file gets no preview rather than a read of all of it.
        const size = (await fs.stat(real).catch(() => null))?.size ?? Infinity;
        const text = size > FILES_LIMITS.readBytes ? '' : await fs.readFile(real, 'utf8').catch(() => '');
        lines.set(real, text.split('\n'));
      }
      const text = lines.get(real)![line - 1] ?? '';
      hits.push({
        path: relPosix,
        line,
        col,
        endLine: l.range.end.line + 1,
        endCol: l.range.end.character + 1,
        preview: text.trim().slice(0, 200),
      });
      if (hits.length >= limits.maxHits) break;
    }
    if (sort) hits.sort((a, b) => (a.path === b.path ? a.line - b.line || a.col - b.col : a.path < b.path ? -1 : 1));
    return hits;
  }

  async function searchAnswer(worktree: string, rel: string, line: number, col: number, f: Fallback, defs: boolean): Promise<NavAnswer> {
    const base = { source: 'search' as const, fallback: f.reason, ...(f.spec ? { server: f.spec.id } : {}) };
    const { real } = await resolveInside(worktree, safeRel(rel));
    const word = await wordAt(real, line, col);
    if (!word) return { ...base, hits: [] };
    const { hits } = await search.searchWord(worktree, word);
    if (!defs) return { ...base, hits };
    const only = hits.filter((h) => search.isDefinition(h, word));
    return { ...base, hits: only.length ? only : search.classifyDefinitions(hits, word) };
  }

  async function navigate(method: string, worktree: string, rel: string, line: number, col: number, defs: boolean): Promise<NavAnswer> {
    try {
      const { entry, uri } = await serverFor(worktree, rel);
      const params: Record<string, unknown> = { textDocument: { uri }, position: { line: line - 1, character: col - 1 } };
      if (!defs) params.context = { includeDeclaration: true };
      const result = await ask<unknown>(entry, method, params);
      return { source: 'lsp', server: entry.spec.id, hits: await toHits(entry.root, toLocations(result), !defs) };
    } catch (err) {
      if (err instanceof Fallback) return searchAnswer(worktree, rel, line, col, err, defs);
      throw err;
    }
  }

  async function sweep(): Promise<void> {
    const cutoff = now() - limits.idleMs;
    await Promise.all([...entries.values()].filter((e) => e.lastUsedAt < cutoff).map(stopEntry));
  }

  return {
    definition: (w, rel, line, col) => navigate('textDocument/definition', w, rel, line, col, true),
    references: (w, rel, line, col) => navigate('textDocument/references', w, rel, line, col, false),

    async hover(worktree, rel, line, col) {
      try {
        const { entry, uri } = await serverFor(worktree, rel);
        const r = await ask<{ contents?: unknown } | null>(entry, 'textDocument/hover', {
          textDocument: { uri },
          position: { line: line - 1, character: col - 1 },
        });
        const markdown = r ? hoverMarkdown(r.contents) : '';
        return markdown ? { server: entry.spec.id, markdown } : null;
      } catch (err) {
        if (err instanceof Fallback) return null;
        throw err;
      }
    },

    async outline(worktree, rel) {
      try {
        const { entry, uri } = await serverFor(worktree, rel);
        const r = await ask<RawSymbol[] | null>(entry, 'textDocument/documentSymbol', { textDocument: { uri } });
        return { server: entry.spec.id, symbols: Array.isArray(r) ? toOutline(r) : [] };
      } catch (err) {
        if (err instanceof Fallback) return { server: null, symbols: [] };
        throw err;
      }
    },

    async servers() {
      return Promise.all(
        specs.map(async (spec): Promise<LspServerStatus> => {
          const binary = await deps.detect.which(spec.cmd[0]!);
          const running = await Promise.all(
            [...entries.values()]
              .filter((e) => e.spec.id === spec.id && e.client.pid !== undefined && e.client.alive)
              .map(async (e) => ({
                worktreePath: e.root,
                pid: e.client.pid!,
                rssBytes: await rss(e.client.pid!).catch(() => null),
                startedAt: new Date(e.startedAt).toISOString(),
                lastUsedAt: new Date(e.lastUsedAt).toISOString(),
              })),
          );
          return {
            id: spec.id,
            lang: spec.lang,
            enabled: await deps.store.isEnabled(spec.id),
            installed: binary !== null,
            ...(binary ? { binary } : {}),
            install: await installOptions(spec, deps.detect),
            running,
            ...(lastError.has(spec.id) ? { lastError: lastError.get(spec.id) } : {}),
          };
        }),
      );
    },

    async setEnabled(id, enabled) {
      await deps.store.setEnabled(id, enabled);
      if (!enabled) await this.stop(id);
      else {
        // Turned back on: a clean slate, failures and all.
        for (const k of crashes.keys()) if (k.endsWith(`\0${id}`)) crashes.delete(k);
        lastError.delete(id);
      }
    },

    async stop(id) {
      await Promise.all([...entries.values()].filter((e) => e.spec.id === id).map(stopEntry));
      // A deliberate stop is a clean slate (Settings' Retry is a stop; so is
      // re-enabling): the next request may start it again.
      for (const k of crashes.keys()) if (k.endsWith(`\0${id}`)) crashes.delete(k);
      lastError.delete(id);
    },

    sweep,

    async closeAll() {
      clearInterval(sweepTimer);
      await Promise.all([...entries.values()].map(stopEntry));
    },
  };
}
