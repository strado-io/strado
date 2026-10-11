// The pre-Focus "Working on" list: `strado:pinned-worktrees-by-ws`, one array
// of pin ids per workspace. Nothing writes it any more; useFocuses reads it
// once per workspace to seed a first Focus, then clears that workspace's
// entry. Kept only for that migration.
const KEY = 'strado:pinned-worktrees-by-ws';

function readAll(): Record<string, string[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([wsId, values]) =>
        Array.isArray(values) ? [[wsId, values.filter((v): v is string => typeof v === 'string')]] : [],
      ),
    );
  } catch {
    return {};
  }
}

export function readLooseWorktrees(wsId: string): string[] {
  return readAll()[wsId] ?? [];
}

export function clearLooseWorktrees(wsId: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [wsId]: [] })); } catch { /* storage off */ }
}
