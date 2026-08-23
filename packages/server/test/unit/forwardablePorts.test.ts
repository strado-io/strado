import { describe, expect, it } from 'vitest';
import {
  allowlistFromEnv,
  forwardablePorts,
  isForwardablePort,
  type PortGateDeps,
} from '../../src/services/forwardablePorts.js';

function deps(opts: {
  worktreePorts?: (number | null)[];
  repoPorts?: number[];
  running?: number[];
  broken?: boolean;
}): PortGateDeps {
  return {
    workspaces: { list: async () => [{ id: 'default' }] },
    registry: {
      get: async () => {
        if (opts.broken) throw new Error('workspaces.json is corrupt');
        return {
          repos: { list: async () => (opts.repoPorts ?? []).map((defaultPort) => ({ defaultPort })) },
          state: { list: async () => (opts.worktreePorts ?? []).map((port) => ({ meta: { port } })) },
        };
      },
    },
    proc: { runningOnPort: (p) => ((opts.running ?? []).includes(p) ? ['/wt/x'] : []) },
  };
}

describe('allowlistFromEnv', () => {
  it('takes single ports and small ranges', () => {
    expect([...allowlistFromEnv('3000, 5173')]).toEqual([3000, 5173]);
    expect([...allowlistFromEnv('8000-8002')]).toEqual([8000, 8001, 8002]);
    expect([...allowlistFromEnv('3000 4000')]).toEqual([3000, 4000]);
  });

  it('ignores junk instead of failing the whole gate', () => {
    // A typo in runner.env must not take port forwarding down entirely, and
    // must not silently widen it either.
    expect([...allowlistFromEnv('abc, 0, 70000, -1')]).toEqual([]);
    expect([...allowlistFromEnv(undefined)]).toEqual([]);
    expect([...allowlistFromEnv('')]).toEqual([]);
  });

  it('refuses a range wide enough to defeat the point of a gate', () => {
    // "1-65535" is not an allowlist. A reversed range is a typo, not an
    // instruction.
    expect([...allowlistFromEnv('1-65535')]).toEqual([]);
    expect([...allowlistFromEnv('9000-8000')]).toEqual([]);
    expect(allowlistFromEnv('8000-8128').size).toBe(129);
  });
});

describe('forwardablePorts', () => {
  it('unions worktree ports, repo defaults and the env allowlist', async () => {
    const ports = await forwardablePorts(
      deps({ worktreePorts: [3001, 3002, null], repoPorts: [8080] }),
      { STRADO_FORWARD_PORTS: '5173' } as NodeJS.ProcessEnv,
    );
    expect([...ports].sort((a, b) => a - b)).toEqual([3001, 3002, 5173, 8080]);
  });

  it('still returns the env allowlist when the stores cannot be read', async () => {
    // A broken workspace must not deny a port the operator opened by hand.
    const ports = await forwardablePorts(deps({ broken: true }), {
      STRADO_FORWARD_PORTS: '3000',
    } as NodeJS.ProcessEnv);
    expect([...ports]).toEqual([3000]);
  });
});

describe('isForwardablePort', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('allows a port a live dev server actually bound', async () => {
    // Frameworks don't always bind what we configured (webpack-dev-server on
    // :443, vite stepping to the next free port). That running server is the
    // exact thing the user is trying to look at.
    expect(await isForwardablePort(deps({ running: [4173] }), 4173, env)).toBe(true);
  });

  it('allows a configured port with nothing running yet', async () => {
    // The forward can be opened before `npm run dev` — otherwise the user has
    // to start the server, then remember to come back and open the port.
    expect(await isForwardablePort(deps({ worktreePorts: [3001] }), 3001, env)).toBe(true);
  });

  it('refuses a port nothing on this box knows about', async () => {
    expect(await isForwardablePort(deps({ worktreePorts: [3001], running: [4173] }), 22, env)).toBe(false);
    expect(await isForwardablePort(deps({}), 5432, env)).toBe(false);
  });

  it('refuses nonsense ports without consulting the stores', async () => {
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(await isForwardablePort(deps({ worktreePorts: [3001] }), bad, env)).toBe(false);
    }
  });
});
