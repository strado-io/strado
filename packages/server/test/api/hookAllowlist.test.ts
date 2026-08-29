// The sandbox hook socket (services/sandbox/hookSocket.ts) forwards a fixed
// list of routes from inside a container to this app. Two things have to keep
// agreeing, and neither file can see the other:
//
//  - every allowlisted path must still BE a route, or hooks report into a 404;
//  - nothing may appear at a path the allowlist names but the app does not
//    serve — `POST /api/events` is off the wall precisely because no route
//    answers it, and mounting one there would silently open it to every
//    sandbox on the machine.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { ALLOW, isAllowed } from '../../src/services/sandbox/hookSocket';

// A concrete URL to probe for each allowlist entry: an exact entry is its own,
// a prefix entry names the path the hooks actually post to. An entry with no
// probe fails the test below — a new hole in the wall does not get to skip
// coverage because nobody added a URL for it.
const PROBES: Record<string, string | undefined> = {
  '/api/claude/status': '/api/claude/status',
  '/api/codex/': '/api/codex/status',
  '/api/opencode/': '/api/opencode/status',
  '/api/pi/': '/api/pi/status',
};

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-hka-')));
  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'home'),
  });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('the sandbox hook allowlist against the real app', () => {
  it('has no POST /api/events route — if one appears, revisit the allowlist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/events', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(isAllowed('POST', '/api/events')).toBe(false);
  });

  it('every allowlisted entry names a route that exists', async () => {
    expect(ALLOW.length).toBeGreaterThan(0);
    for (const rule of ALLOW) {
      const url = PROBES[rule.path];
      expect(url, `no probe URL for allowlist entry ${rule.method} ${rule.path}`).toBeDefined();
      expect(isAllowed(rule.method, url)).toBe(true);
      const res = await app.inject({ method: rule.method, url: url!, payload: {} });
      expect(res.statusCode, `${rule.method} ${url} is allowlisted but not routed`).not.toBe(404);
    }
  });

  it('a prefix entry opens its own segment and not its neighbours', async () => {
    for (const rule of ALLOW.filter((r) => r.prefix)) {
      // `/api/codex/` must not also admit `/api/codexplus` — the trailing
      // slash is the whole defence, and dropping it would widen every prefix
      // entry to a string match over the parent segment.
      const sibling = rule.path.replace(/\/$/, 'plus');
      expect(isAllowed(rule.method, sibling)).toBe(false);
      expect(isAllowed(rule.method, `${sibling}/status`)).toBe(false);
    }
  });
});
