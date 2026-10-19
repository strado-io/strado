// Chips in the command box: `@` for an agent, `#` for a worktree. The box
// shows `@label` / `#label`; each chip remembers exactly what it was picked as,
// and what is submitted carries it inline as `@{agentId}` or
// `#{encodeURIComponent(worktreePath)}` (lib/jarvis resolves those exactly, no lookup).
import type { StationDto } from '../../api';
import type { TabRef } from '../jarvis/types';
import { lightOf } from '../dock/stations';
import type { Station } from './rank';

export type Sigil = '@' | '#';
export type Chip = { label: string; agentId: string } | { label: string; worktreePath: string };
export type Mention = { start: number; query: string; sigil: Sigil };

export const sigilOf = (c: Chip): Sigil => ('worktreePath' in c ? '#' : '@');
/** A stable key for the chip (test ids, React keys). */
export const chipKey = (c: Chip): string => ('worktreePath' in c ? `#${c.worktreePath}` : c.agentId);
const wireOf = (c: Chip): string => ('worktreePath' in c ? `#{${encodeURIComponent(c.worktreePath)}}` : `@{${c.agentId}}`);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `@label` / `#label` as a whole token: at the start or after whitespace, then whitespace or the end.
const tokenRe = (c: Chip) => new RegExp(`(^|\\s)${sigilOf(c)}${escape(c.label)}(?=\\s|$)`, 'g');

/** The mention being typed at `caret`: an `@` or `#` that starts a word, with
 * no whitespace between it and the caret. */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[3]!.length - 1, query: m[3]!, sigil: m[2] as Sigil };
}

/** Replace the mention with `@label ` / `#label ` (one space after), caret past it. */
export function insertChip(text: string, mention: Mention, label: string): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const after = text.slice(end);
  const token = `${mention.sigil}${label}`;
  const sep = after.startsWith(' ') ? '' : ' ';
  const next = text.slice(0, mention.start) + token + sep + after;
  return { text: next, caret: mention.start + token.length + 1 };
}

/** What is submitted: each chip's first remaining token becomes its exact wire form. */
export function toWire(text: string, chips: Chip[]): string {
  let out = text;
  for (const c of chips) {
    let done = false;
    out = out.replace(tokenRe(c), (whole, lead: string) => {
      if (done) return whole;
      done = true;
      return `${lead}${wireOf(c)}`;
    });
  }
  return out;
}

/** The text as plain runs and chip runs, for drawing chips in the box. Marks
 * the same tokens `toWire` replaces (each chip's first whole `@label`). */
export function chipSegments(text: string, chips: Chip[]): { text: string; chip?: Chip }[] {
  const marks: { start: number; end: number; chip: Chip }[] = [];
  for (const c of chips) {
    const re = tokenRe(c);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + m[1]!.length;
      const end = start + c.label.length + 1;
      if (!marks.some((x) => start < x.end && end > x.start)) { marks.push({ start, end, chip: c }); break; }
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const out: { text: string; chip?: Chip }[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) out.push({ text: text.slice(at, m.start) });
    out.push({ text: text.slice(m.start, m.end), chip: m.chip });
    at = m.end;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at) });
  return out;
}

/** Chips still present as whole `@label` tokens (one token per chip). */
export function pruneChips(text: string, chips: Chip[]): Chip[] {
  const left = new Map<string, number>();
  return chips.filter((c) => {
    const k = sigilOf(c) + c.label;
    const total = (text.match(tokenRe(c)) ?? []).length;
    const used = left.get(k) ?? 0;
    if (used >= total) return false;
    left.set(k, used + 1);
    return true;
  });
}

/** The chip whose `@label` ends exactly at `caret` (backspace removes it whole). */
export function chipEndingAt(text: string, caret: number, chips: Chip[]): { chip: Chip; start: number } | null {
  for (const c of chips) {
    const token = `${sigilOf(c)}${c.label}`;
    const start = caret - token.length;
    if (start < 0 || text.slice(start, caret) !== token) continue;
    if (start > 0 && !/\s/.test(text[start - 1]!)) continue;
    return { chip: c, start };
  }
  return null;
}

/** The chip's `@label`, chosen so it resolves back to the same agent when the
 * text is recalled from history without its chips: the alias, else the name in
 * this worktree, else `<worktree>/<name>` (never a same-named agent here). */
export function chipLabel(s: Pick<Station, 'name' | 'alias' | 'worktreeName' | 'inThisWorktree'>): string {
  return s.alias ?? (s.inThisWorktree ? s.name : `${s.worktreeName}/${s.name}`);
}

/** A stations-feed row in the ranking's shape. */
export function toRankStation(s: StationDto, worktreePath: string | null, focused: TabRef | null): Station {
  const light = lightOf(s);
  return {
    agentId: s.agentId,
    name: s.name,
    alias: s.alias,
    worktreeName: s.worktreeName,
    inThisWorktree: worktreePath !== null && s.worktreePath === worktreePath,
    focused: !!focused && focused.worktreePath === s.worktreePath && focused.mode === s.mode && focused.sessionId === s.sessionId,
    status: light,
    lastActivityAt: s.lastActivityAt ?? 0,
  };
}
