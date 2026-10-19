// A plan for a worktree that is not on screen opens it first (as a click in
// Recent would) and waits for its hub to come up, so the new tabs appear there.

/** How long a worktree gets to open its hub before the plan gives up. */
export const HUB_OPEN_MS = 5_000;
const POLL_MS = 50;

export async function openWorktreeAndWait<P>(
  path: string,
  current: () => { path: string; port: P | null } | null,
  open: (path: string) => void,
  timeoutMs = HUB_OPEN_MS,
): Promise<P | null> {
  const ready = () => { const c = current(); return c && c.path === path ? c.port : null; };
  const now = ready();
  if (now) return now;
  open(path);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const p = ready();
    if (p) return p;
  }
  return null;
}
