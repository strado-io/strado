import { useEffect, useRef, useState } from 'react';
import { api, type Focus } from '../../api';
import type { ChatEntry } from '../../types';

// The sidebar's badges for Focuses whose chat is not open: approvals waiting
// (⚠) and a reply this window has not seen (✦). Cheap on purpose: one small
// log page per Focus, fetched when the list changes, when the window comes
// back, on the existing live events (`pulse`, at most every PULSE_MIN_MS),
// and every POLL_MS as a backstop. No stream per Focus.

export type JarvisBadge = { pendingApprovals: number; unread: boolean };

const SEEN_KEY = 'strado:jarvis-seen';
const PAGE = 20;
const PULSE_MIN_MS = 10_000;
const POLL_MS = 60_000;

/** Jarvis's latest reply, its first line (streaming or finished); '' when none yet. */
export function latestLine(entries: ChatEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'jarvis' && e.text.trim()) return e.text.trim().split('\n')[0]!.trim();
  }
  return '';
}

/** The newest finished reply in a page of the log, if any. */
export function newestReply(entries: ChatEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'jarvis' && e.done) return e.id;
  }
  return null;
}

// Per window (sessionStorage): another window has its own idea of what was read.
function readSeen(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(SEEN_KEY) || '{}') as Record<string, string>; } catch { return {}; }
}
/** This window has seen the chat up to `entryId` (the chat was open). */
export function markSeen(focusId: string, entryId: string): void {
  try {
    const all = readSeen();
    if (all[focusId] === entryId) return;
    all[focusId] = entryId;
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch { /* storage off: everything reads as seen next time */ }
}

export function useFocusJarvisBadges(wsId: string, focuses: Focus[], activeId: string | null, pulse: unknown): Map<string, JarvisBadge> {
  const [badges, setBadges] = useState<Map<string, JarvisBadge>>(new Map());
  const ids = focuses.filter((f) => f.id !== activeId).map((f) => f.id);
  const key = `${wsId}|${ids.join(',')}`;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const lastRun = useRef(0);
  const [tick, setTick] = useState(0);

  // Fetch now for this list, then on window focus and every POLL_MS.
  useEffect(() => {
    let live = true;
    const run = () => {
      lastRun.current = Date.now();
      const seen = readSeen();
      for (const id of idsRef.current) {
        api.focusJarvis.log(wsId, id, { limit: PAGE }).then((page) => {
          if (!live) return;
          const newest = newestReply(page.entries);
          const badge = { pendingApprovals: page.meta.pendingApprovals, unread: newest !== null && seen[id] !== newest };
          setBadges((cur) => {
            const was = cur.get(id);
            if (was && was.pendingApprovals === badge.pendingApprovals && was.unread === badge.unread) return cur;
            return new Map(cur).set(id, badge);
          });
        }).catch(() => { /* badges are best effort */ });
      }
    };
    run();
    const onFocus = () => run();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(run, POLL_MS);
    return () => { live = false; window.removeEventListener('focus', onFocus); clearInterval(timer); };
    // `tick` re-runs it for a pulse.
  }, [key, wsId, tick]);

  // A live event (agents, calls): refresh, but not more than every PULSE_MIN_MS.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const wait = Math.max(0, lastRun.current + PULSE_MIN_MS - Date.now());
    const t = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [pulse]);

  return badges;
}
