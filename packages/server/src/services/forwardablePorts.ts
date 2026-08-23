// Which loopback ports this machine will let a tunnel client reach.
//
// NOT a privilege boundary: anyone who can open a forwarding channel already has
// a shell on this box through the same tunnel. It is defense in depth, so that a
// bug or a stolen ticket cannot become "enumerate the runner's loopback", and so
// the refusal log means something.
//
// Runs in-process on the runner: the daemon builds the server's deps and the
// tunnel client in one process, so the gate reads the same stores the API does
// with no HTTP round trip on the connection path.

/** Ports an operator has opted into by hand, via runner.env. */
export function allowlistFromEnv(raw: string | undefined): Set<number> {
  const ports = new Set<number>();
  for (const part of (raw ?? '').split(/[,\s]+/)) {
    if (!part) continue;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      // A reversed or oversized range is a typo, not an instruction to open
      // 60k ports — the whole point of the gate is that it stays small.
      if (from <= to && to - from <= 128) {
        for (let p = from; p <= to; p++) if (isPort(p)) ports.add(p);
      }
      continue;
    }
    const single = Number(part);
    if (isPort(single)) ports.add(single);
  }
  return ports;
}

function isPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n < 65536;
}

export type PortGateDeps = {
  workspaces: { list(): Promise<{ id: string }[]> };
  registry: {
    get(wsId: string): Promise<{
      repos: { list(): Promise<{ defaultPort: number }[]> };
      state: { list(): Promise<{ meta: { port: number | null } }[]> };
    }>;
  };
  proc: { runningOnPort(port: number): string[] };
};

/**
 * Every port this machine currently considers forwardable. Union of:
 * running dev servers, each worktree's configured port, each repo's default,
 * and the operator's explicit allowlist.
 *
 * Recomputed per call rather than cached: a worktree created a second ago must
 * be forwardable now, and a stale allow is the wrong way to fail.
 */
export async function forwardablePorts(deps: PortGateDeps, env = process.env): Promise<Set<number>> {
  const ports = allowlistFromEnv(env.STRADO_FORWARD_PORTS);
  // Every workspace, not just the active one: a remote hub can be opened on a
  // worktree belonging to a workspace this runner isn't "looking at".
  const workspaces = await deps.workspaces.list().catch(() => []);
  for (const ws of workspaces) {
    let stores;
    try {
      stores = await deps.registry.get(ws.id);
    } catch {
      continue; // a broken workspace must not deny the healthy ones
    }
    for (const entry of await stores.state.list().catch(() => [])) {
      if (entry.meta.port != null && isPort(entry.meta.port)) ports.add(entry.meta.port);
    }
    for (const repo of await stores.repos.list().catch(() => [])) {
      if (isPort(repo.defaultPort)) ports.add(repo.defaultPort);
    }
  }
  return ports;
}

/**
 * The gate itself. Checks the cheap live-process case first: a dev server that
 * bound a port we never configured (webpack-dev-server on :443, a framework
 * picking the next free port) is exactly the thing the user is trying to look
 * at, and refusing it would be the most confusing possible failure.
 */
export async function isForwardablePort(deps: PortGateDeps, port: number, env = process.env): Promise<boolean> {
  if (!isPort(port)) return false;
  if (deps.proc.runningOnPort(port).length > 0) return true;
  return (await forwardablePorts(deps, env)).has(port);
}
