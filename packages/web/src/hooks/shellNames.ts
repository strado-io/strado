import { useEffect, useState } from 'react';

// Custom display names for pty session tabs. Shells keep the legacy
// `path::sessionId` key (saved names survive); agent tabs (claude/codex/
// opencode/pi) key by `path::mode::sessionId`. Client-side only (like vscode
// tabs): the server tracks sessions by numeric id and doesn't need to know
// what a human calls them. Persisted so names survive panel reopen and
// reload; broadcast so every open view updates live.
const KEY = 'strado:shell-names';
const EVENT = 'strado:shell-names';

export type NamedSessionMode = 'shell' | 'claude' | 'codex' | 'opencode' | 'pi';

export function shellNameKey(path: string, id: string): string {
  return `${path}::${id}`;
}

export function sessionNameKey(path: string, mode: NamedSessionMode, id: string): string {
  return mode === 'shell' ? shellNameKey(path, id) : `${path}::${mode}::${id}`;
}

export function readShellNames(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// Empty/whitespace name clears the entry — the tab falls back to its default
// label ("Shell", "Claude 2", …).
export function renameSession(path: string, mode: NamedSessionMode, id: string, name: string): void {
  const names = readShellNames();
  const key = sessionNameKey(path, mode, id);
  const trimmed = name.trim();
  if (trimmed) names[key] = trimmed;
  else delete names[key];
  localStorage.setItem(KEY, JSON.stringify(names));
  window.dispatchEvent(new Event(EVENT));
}

export function renameShell(path: string, id: string, name: string): void {
  renameSession(path, 'shell', id, name);
}

export function useShellNames(): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>(readShellNames);
  useEffect(() => {
    const update = () => setNames(readShellNames());
    window.addEventListener(EVENT, update);
    // cross-browser-tab changes
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return names;
}
