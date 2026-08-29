import { useEffect, useState } from 'react';

// Which worktrees have a Browser preview tab open in the hub (Electron
// webview — client-side only, like VS Code tabs). Persisted so the tab and
// its URL survive panel reopen; broadcast so the sessions dock stays live.
const KEY = 'strado:browser-tabs';
const URL_KEY = 'strado:browser-urls';
const CLEAN_START_MIGRATION_KEY = 'strado:browser-clean-start-v1';
const EVENT = 'strado:browser-tabs';

export function readBrowserTabs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function rememberBrowserTab(path: string, open: boolean): void {
  const tabs = readBrowserTabs();
  if (open) tabs.add(path);
  else tabs.delete(path);
  localStorage.setItem(KEY, JSON.stringify([...tabs]));
  window.dispatchEvent(new Event(EVENT));
}

// Extra Browser tab ids per worktree (tab 1 lives in the Set above).
// Preview keys: tab 1 = the worktree path (historical - persisted URLs and
// the main-process registry keep working), extras = `<path>\0browser:<id>`.
const IDS_KEY = 'strado:browser-tab-ids';

export function previewKey(path: string, id: string): string {
  return id === '1' ? path : `${path}\0browser:${id}`;
}

export function readBrowserTabIds(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(IDS_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [p, ids] of Object.entries(raw)) {
      if (Array.isArray(ids)) {
        const clean = ids.filter((i): i is string => typeof i === 'string' && /^\d+$/.test(i) && i !== '1');
        if (clean.length) out[p] = clean;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberBrowserTabIds(path: string, ids: string[]): void {
  const all = readBrowserTabIds();
  const clean = ids.filter((i) => i !== '1');
  if (clean.length) all[path] = clean;
  else delete all[path];
  localStorage.setItem(IDS_KEY, JSON.stringify(all));
  window.dispatchEvent(new Event(EVENT));
}

// Last-known page title + favicon per preview key. Previews only exist while
// their tab has been visited, so after an app restart the live page can't be
// asked — the persisted copy labels the tab until the page loads and
// overwrites it (same as a real browser restoring a session).
const META_KEY = 'strado:browser-meta';
export type BrowserTabMeta = { title?: string; favicon?: string | null };

export function readBrowserMeta(): Record<string, BrowserTabMeta> {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, BrowserTabMeta> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'object' || v === null) continue;
      const m = v as BrowserTabMeta;
      const clean: BrowserTabMeta = {};
      if (typeof m.title === 'string') clean.title = m.title;
      if (typeof m.favicon === 'string') clean.favicon = m.favicon;
      if (Object.keys(clean).length) out[k] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/** merge patch into the key's meta; null removes the key (tab closed) */
export function rememberBrowserMeta(key: string, patch: BrowserTabMeta | null): void {
  try {
    const all = readBrowserMeta();
    if (patch === null) delete all[key];
    else all[key] = { ...all[key], ...patch };
    localStorage.setItem(META_KEY, JSON.stringify(all));
  } catch { /* storage blocked — labels just won't survive restart */ }
}

// Tab label = the live page title (like a real browser), falling back to
// Browser / Browser N while the page hasn't reported one.
export function browserTabLabel(title: string | undefined, id: string, max = 24): string {
  const t = title?.trim();
  if (!t) return id === '1' ? 'Browser' : `Browser ${id}`;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function readBrowserUrls(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(URL_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Older builds guessed localhost:3000 for every new Browser tab. Remove those
 * generated defaults once so existing users reach the clean start page; URLs
 * entered after this migration (including localhost:3000) remain untouched.
 */
export function migrateGuessedBrowserUrls(): Record<string, string> {
  const urls = readBrowserUrls();
  try {
    if (localStorage.getItem(CLEAN_START_MIGRATION_KEY) === '1') return urls;
    for (const [key, url] of Object.entries(urls)) {
      if (/^http:\/\/(?:localhost|127\.0\.0\.1):3000\/?$/.test(url)) delete urls[key];
    }
    localStorage.setItem(URL_KEY, JSON.stringify(urls));
    localStorage.setItem(CLEAN_START_MIGRATION_KEY, '1');
  } catch { /* storage unavailable — use the in-memory cleaned map */ }
  return urls;
}

/** null forgets the key (tab closed) — ids are reused, so a leftover URL
 * would turn the next "new" tab into the closed one */
export function rememberBrowserUrl(path: string, url: string | null): void {
  const all = readBrowserUrls();
  if (url === null) delete all[path];
  else all[path] = url;
  localStorage.setItem(URL_KEY, JSON.stringify(all));
}

export function useBrowserTabs(): Set<string> {
  const [tabs, setTabs] = useState<Set<string>>(readBrowserTabs);
  useEffect(() => {
    const update = () => setTabs(readBrowserTabs());
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return tabs;
}
