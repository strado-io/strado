// Jarvis box memory, all local to this browser (typed text never leaves the
// machine): command history for ↑ recall, frecency to rank interpretations the
// user keeps choosing, and a log of inputs no rule understood — the dataset
// for growing the parser's rules by hand.

import { pruneChips, type Chip } from '../mention/chips';

const HISTORY_KEY = 'strado:jarvis-history';
const FRECENCY_KEY = 'strado:jarvis-frecency';
const FALLTHROUGH_KEY = 'strado:jarvis-fallthrough';
export const HISTORY_MAX = 50;
export const FALLTHROUGH_MAX = 200;
const FRECENCY_MAX = 300;
// A use counts half as much after a week.
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked — memory just won't persist */ }
}

// Text that looks like it carries a credential is never written down: history
// and the fall-through log live in localStorage, readable by anything sharing
// this origin, and outlive the session.
const SECRET_PATTERNS: RegExp[] = [
  /(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?\s*[=:]/i,
  /\bauthorization\s*:/i,
  /\bbearer\s+\S/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // scheme://user:password@host
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_/,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bxox[abpr]-/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /_authToken/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // a JWT
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/, // npm
];
export const looksSecret = (text: string): boolean => SECRET_PATTERNS.some((re) => re.test(text));

/** A remembered command; `pasted` keeps a pasted command from becoming a
 * one-key replay (it still needs the second ⏎ when recalled). `chips` are the
 * @/# mentions it was typed with, so a recall draws (and resolves) them again. */
export type HistoryEntry = { text: string; pasted: boolean; chips?: Chip[] };
type Stored = string | { t: string; p?: 1; c?: Chip[] };

const isChip = (c: unknown): c is Chip => {
  const x = c as { label?: unknown; agentId?: unknown; worktreePath?: unknown } | null;
  return !!x && typeof x === 'object' && typeof x.label === 'string' && (typeof x.agentId === 'string' || typeof x.worktreePath === 'string');
};
const toStored = (e: HistoryEntry): Stored => (e.pasted || e.chips ? { t: e.text, ...(e.pasted ? { p: 1 as const } : {}), ...(e.chips ? { c: e.chips } : {}) } : e.text);
const entry = (text: string, pasted: boolean, chips: Chip[]): HistoryEntry => (chips.length ? { text, pasted, chips } : { text, pasted });

export function readHistoryEntries(wsId: string): HistoryEntry[] {
  const list = read<Record<string, unknown>>(HISTORY_KEY, {})[wsId];
  if (!Array.isArray(list)) return [];
  const out: HistoryEntry[] = [];
  for (const e of list as unknown[]) {
    if (typeof e === 'string') out.push({ text: e, pasted: false });
    else if (e && typeof e === 'object' && typeof (e as { t?: unknown }).t === 'string') {
      const { t, p, c } = e as { t: string; p?: unknown; c?: unknown };
      out.push(entry(t, p === 1, Array.isArray(c) ? c.filter(isChip) : []));
    }
  }
  return out;
}
export const readHistory = (wsId: string): string[] => readHistoryEntries(wsId).map((e) => e.text);

export function rememberCommand(wsId: string, text: string, opts: { pasted?: boolean; chips?: Chip[] } = {}): void {
  const t = text.trim();
  if (!t || looksSecret(t)) return;
  const all = read<Record<string, Stored[]>>(HISTORY_KEY, {});
  const first = entry(t, !!opts.pasted, pruneChips(t, opts.chips ?? []));
  all[wsId] = [first, ...readHistoryEntries(wsId).filter((e) => e.text !== t)].map(toStored).slice(0, HISTORY_MAX);
  write(HISTORY_KEY, all);
}

type Use = { n: number; last: number };
export function recordUse(wsId: string, key: string): void {
  const all = read<Record<string, Record<string, Use>>>(FRECENCY_KEY, {});
  const mine = { ...(all[wsId] ?? {}) };
  const prev = mine[key];
  mine[key] = { n: (prev?.n ?? 0) + 1, last: Date.now() };
  // Keep the most recently used keys only.
  const kept = Object.entries(mine).sort((a, b) => b[1].last - a[1].last).slice(0, FRECENCY_MAX);
  all[wsId] = Object.fromEntries(kept);
  write(FRECENCY_KEY, all);
}

/** Uses, decayed by how long ago the last one was; 0 for never. */
export function frecencyScore(wsId: string, key: string): number {
  const use = read<Record<string, Record<string, Use>>>(FRECENCY_KEY, {})[wsId]?.[key];
  if (!use || typeof use.n !== 'number') return 0;
  const age = Math.max(0, Date.now() - use.last);
  return use.n * Math.pow(0.5, age / HALF_LIFE_MS);
}

export type FallthroughEntry = { text: string; at: number };
export function readFallthrough(): FallthroughEntry[] {
  const v = read<unknown>(FALLTHROUGH_KEY, []);
  return Array.isArray(v) ? (v as FallthroughEntry[]) : [];
}
export function logFallthrough(text: string): void {
  const t = text.trim();
  if (!t || looksSecret(t)) return;
  write(FALLTHROUGH_KEY, [...readFallthrough(), { text: t, at: Date.now() }].slice(-FALLTHROUGH_MAX));
}

/** "Clear history": this workspace's commands and frecency, plus the (global) fall-through log. */
export function clearHistory(wsId: string): void {
  const h = read<Record<string, unknown>>(HISTORY_KEY, {});
  delete h[wsId];
  write(HISTORY_KEY, h);
  const f = read<Record<string, unknown>>(FRECENCY_KEY, {});
  delete f[wsId];
  write(FRECENCY_KEY, f);
  write(FALLTHROUGH_KEY, []);
}
