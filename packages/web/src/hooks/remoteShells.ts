// Remote shell tabs the user has opened on a runner, per local worktree.
//
// Client-side on purpose, like `localShellIds`: the pty itself lives on the
// runner (and outlives this window), but nothing in the LOCAL server knows the
// tab exists. Persisting the list is what makes "quit the app, reopen, the
// agent is still running" visible instead of merely true — without it the
// session survives but the user has no tab pointing at it.
import type { RemoteTarget } from '../components/XtermPane';

/** A remote target plus the session id it occupies in the tab strip. */
export type RemoteShell = RemoteTarget & { id: string };

const STORE = 'strado.remoteShells';

type ShellMap = Record<string, RemoteShell[]>;

function readAll(): ShellMap {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: ShellMap = {};
    for (const [path, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      // Validate every field: a half-written entry would render a tab whose
      // socket URL is `wss://undefined/...`, which fails in a way that looks
      // like the runner is down.
      out[path] = list.filter(
        (s): s is RemoteShell =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as RemoteShell).runnerId === 'string' &&
          typeof (s as RemoteShell).wsBase === 'string' &&
          typeof (s as RemoteShell).wsId === 'string' &&
          typeof (s as RemoteShell).path === 'string' &&
          typeof (s as RemoteShell).id === 'string',
      );
    }
    return out;
  } catch {
    return {};
  }
}

export function readRemoteShells(): ShellMap {
  return readAll();
}

export function rememberRemoteShells(path: string, shells: RemoteShell[]): void {
  try {
    const all = readAll();
    if (shells.length === 0) delete all[path];
    else all[path] = shells;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* storage unavailable — remote tabs just won't survive a reload */
  }
}
